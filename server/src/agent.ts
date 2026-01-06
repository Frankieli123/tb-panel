import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import http from 'node:http';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { autoCartAdder } from './services/autoCartAdder.js';
import { cartScraper } from './services/cartScraper.js';
import { AGENT_STATUS_HTML } from './ui/agentStatusPage.js';

dotenv.config();

type RpcMessage = {
  type: 'rpc';
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
};

type AgentStore = {
  agentId: string;
  agentToken?: string;
  createdAt?: string;
  updatedAt?: string;
};

type LocalStatus = {
  connected: boolean;
  agentId: string;
  wsUrl: string;
  adminUrl: string;
  hasToken: boolean;
  lastError: string | null;
  statusUrl: string;
  logs: string[];
};

function getArgValue(flag: string): string | null {
  const argv = process.argv;

  // supports:
  // - `--flag value`
  // - `--flag=value`
  const exactIdx = argv.indexOf(flag);
  if (exactIdx !== -1) {
    const v = argv[exactIdx + 1];
    return v ? String(v) : null;
  }

  const prefix = `${flag}=`;
  const withEq = argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  if (withEq) return String(withEq.slice(prefix.length));

  return null;
}

function hasFlag(flag: string): boolean {
  const argv = process.argv;
  return argv.includes(flag) || argv.some((a) => typeof a === 'string' && a.startsWith(`${flag}=`));
}

function required(name: string, value: string | undefined | null): string {
  const v = String(value || '').trim();
  if (!v) throw new Error(`Missing required ${name}`);
  return v;
}

function getAgentStoreDir(): string {
  const explicit = String(process.env.TAOBAO_AGENT_HOME || '').trim();
  if (explicit) return explicit;

  const base =
    String(process.env.PROGRAMDATA || '').trim() ||
    String(process.env.APPDATA || '').trim() ||
    os.homedir();

  return path.join(base, 'TaobaoAgent');
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|y|on)$/i.test(String(value ?? '').trim());
}

function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // Treat "permission denied" as "process exists" to avoid false takeover.
    if (String(err?.code || '') === 'EPERM') return true;
    return false;
  }
}

async function openUrlBestEffort(url: string): Promise<void> {
  const u = String(url || '').trim();
  if (!u) return;
  try {
    if (process.platform === 'win32') {
      const { spawn } = await import('node:child_process');
      spawn('cmd', ['/c', 'start', '""', u], { detached: true, stdio: 'ignore' }).unref();
      return;
    }

    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [u], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

async function findExistingStatusUiUrl(): Promise<string | null> {
  for (let port = 17880; port <= 17890; port++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: ctrl.signal });
        if (res.ok) return `http://127.0.0.1:${port}/`;
      } finally {
        clearTimeout(t);
      }
    } catch {}
  }
  return null;
}

type AgentLock = { release: () => Promise<void> };

async function acquireAgentLock(addLog: (msg: string) => void): Promise<AgentLock | null> {
  const dir = getAgentStoreDir();
  const lockPath = path.join(dir, 'agent.lock');
  await fs.mkdir(dir, { recursive: true });

  const tryCreate = async (): Promise<fs.FileHandle | null> => {
    try {
      return await fs.open(lockPath, 'wx');
    } catch (err: any) {
      if (String(err?.code || '') === 'EEXIST') return null;
      throw err;
    }
  };

  const handle = await tryCreate();
  if (handle) {
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
        'utf-8'
      );
    } catch {}

    const release = async () => {
      try {
        await handle.close();
      } catch {}
      try {
        await fs.unlink(lockPath);
      } catch {}
    };

    return { release };
  }

  // Lock exists: attempt to detect stale PID and recover.
  let otherPid: number | null = null;
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const pidNum = Number.parseInt(String(parsed?.pid || '').trim(), 10);
    if (Number.isFinite(pidNum) && pidNum > 0) otherPid = pidNum;
  } catch {}

  if (otherPid && !isPidRunning(otherPid)) {
    try {
      await fs.unlink(lockPath);
    } catch {}
    const retry = await tryCreate();
    if (retry) {
      try {
        await retry.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), recoveredFromPid: otherPid }, null, 2),
          'utf-8'
        );
      } catch {}
      const release = async () => {
        try {
          await retry.close();
        } catch {}
        try {
          await fs.unlink(lockPath);
        } catch {}
      };
      addLog(`Recovered stale lock from pid=${otherPid}`);
      return { release };
    }
  }

  addLog(`Another agent instance is running (pid=${otherPid ?? 'unknown'})`);
  return null;
}

async function loadStoredAgentStore(): Promise<AgentStore | null> {
  const storePath = path.join(getAgentStoreDir(), 'agent.json');
  try {
    const raw = await fs.readFile(storePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const agentId = String(parsed?.agentId || '').trim();
    if (!agentId) return null;

    const agentToken = String(parsed?.agentToken || '').trim();
    return {
      agentId,
      agentToken: agentToken || undefined,
      createdAt: typeof parsed?.createdAt === 'string' ? parsed.createdAt : undefined,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch {
    return null;
  }
}

async function saveStoredAgentStore(store: AgentStore): Promise<void> {
  const dir = getAgentStoreDir();
  const storePath = path.join(dir, 'agent.json');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        agentId: store.agentId,
        agentToken: store.agentToken,
        createdAt: store.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf-8'
  );
}

async function getOrCreateAgentId(): Promise<string> {
  const explicit = String(process.env.AGENT_ID || getArgValue('--id') || '').trim();
  if (explicit) return explicit;

  const stored = await loadStoredAgentStore();
  if (stored?.agentId) return stored.agentId;

  const generated = randomUUID();
  await saveStoredAgentStore({ agentId: generated });
  console.log(`[Agent] Generated agentId=${generated} and saved to ${path.join(getAgentStoreDir(), 'agent.json')}`);
  return generated;
}

function deriveAdminUrl(wsBase: string): string {
  const url = new URL(wsBase);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function deriveHttpRedeemUrl(wsBase: string): string {
  const url = new URL(wsBase);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  url.pathname = '/api/agents/redeem';
  url.search = '';
  return url.toString();
}

async function redeemPairCode(options: { wsBase: string; agentId: string; code: string }): Promise<string> {
  const redeemUrl =
    String(process.env.AGENT_HTTP_REDEEM_URL || getArgValue('--redeem-url') || '').trim() ||
    deriveHttpRedeemUrl(options.wsBase);

  const res = await fetch(redeemUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: options.code, agentId: options.agentId }),
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch {}

  if (!res.ok || !data?.success) {
    const msg = data?.error ? String(data.error) : `HTTP ${res.status}`;
    throw new Error(`Pair redeem failed: ${msg}`);
  }

  const token = String(data?.data?.token || '').trim();
  if (!token) throw new Error('Pair redeem failed: missing token');
  return token;
}

async function ensureUiOpenedOnce(statusUrl: string): Promise<void> {
  const dir = getAgentStoreDir();
  const flagPath = path.join(dir, 'ui-opened.txt');
  try {
    await fs.access(flagPath);
    return;
  } catch {}

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(flagPath, new Date().toISOString(), 'utf-8');

  const url = String(statusUrl || '').trim();
  if (!url) return;

  await openUrlBestEffort(url);
}

async function startStatusServer(options: {
  port: number;
  logs: string[];
  getStatus: () => LocalStatus;
  pair: (code: string) => Promise<void>;
}): Promise<{ port: number; url: string }> {
  const basePort = Number.isFinite(options.port) ? options.port : 17880;

  const addLog = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    options.logs.push(line);
    if (options.logs.length > 250) options.logs.splice(0, options.logs.length - 250);
  };

  const readJsonBody = async (req: http.IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  };

  const sendJson = (res: http.ServerResponse, status: number, payload: any) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const pathname = url.pathname;

      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(AGENT_STATUS_HTML);
        return;
      }

      if (method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, { success: true, data: options.getStatus() });
        return;
      }

      if (method === 'POST' && pathname === '/api/pair') {
        const body = await readJsonBody(req);
        const code = String(body?.code || '').trim();
        if (!code) {
          sendJson(res, 400, { success: false, error: 'Missing code' });
          return;
        }
        await options.pair(code);
        sendJson(res, 200, { success: true });
        return;
      }

      sendJson(res, 404, { success: false, error: 'Not found' });
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : String(err);
      addLog(`Status server error: ${msg}`);
      sendJson(res, 500, { success: false, error: msg });
    }
  });

  const tryListen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: any) => reject(err);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });

  let chosenPort = basePort;
  for (let i = 0; i <= 10; i++) {
    try {
      chosenPort = basePort + i;
      await tryListen(chosenPort);
      break;
    } catch (err: any) {
      const code = String(err?.code || '');
      if (code !== 'EADDRINUSE') throw err;
      if (i === 10) throw err;
    }
  }

  const url = `http://127.0.0.1:${chosenPort}/`;
  addLog(`Status UI ready: ${url}`);
  console.log(`[Agent] Status UI: ${url}`);
  return { port: chosenPort, url };
}

async function main(): Promise<void> {
  const agentId = await getOrCreateAgentId();
  const wsBase =
    String(process.env.AGENT_WS_URL || getArgValue('--ws') || '').trim() ||
    `ws://127.0.0.1:${process.env.PORT || '4000'}/ws/agent`;

  const uiMode = isTruthy(process.env.AGENT_UI || process.env.AGENT_STATUS_UI);
  const statusPort = Number.parseInt(String(process.env.AGENT_STATUS_PORT || '').trim(), 10);
  const statusLogs: string[] = [];

  const addLog = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    statusLogs.push(line);
    if (statusLogs.length > 250) statusLogs.splice(0, statusLogs.length - 250);
  };

  const lock = await acquireAgentLock(addLog);
  if (!lock) {
    // Best effort: open the already-running UI for non-technical users.
    const existing = await findExistingStatusUiUrl();
    if (existing) {
      addLog(`Opening existing status UI: ${existing}`);
      await openUrlBestEffort(existing);
    }
    return;
  }

  const releaseLock = async () => {
    try {
      await lock.release();
    } catch {}
  };
  process.on('exit', () => {
    void releaseLock();
  });
  process.on('SIGINT', () => {
    void releaseLock().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void releaseLock().finally(() => process.exit(0));
  });

  const envToken = String(process.env.AGENT_TOKEN || process.env.API_KEY || '').trim();
  const pairCode = String(process.env.AGENT_PAIR_CODE || getArgValue('--pair') || '').trim();
  const pairOnly = /^(1|true)$/i.test(String(process.env.AGENT_PAIR_ONLY || '').trim()) || hasFlag('--pair-only');

  const stored = await loadStoredAgentStore();
  const storedToken = String(stored?.agentToken || '').trim();

  let token = envToken || storedToken;
  const adminUrl = String(process.env.AGENT_ADMIN_URL || '').trim() || deriveAdminUrl(wsBase);

  const status: LocalStatus = {
    connected: false,
    agentId,
    wsUrl: wsBase,
    adminUrl,
    hasToken: Boolean(token),
    lastError: null,
    statusUrl: '',
    logs: statusLogs,
  };

  const getStatus = (): LocalStatus => ({ ...status, logs: statusLogs.slice(-250) });

  let ws: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const clearReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const stopWs = () => {
    clearReconnect();
    if (!ws) return;
    try {
      ws.close(1000, 'Stopping');
    } catch {}
    ws = null;
    status.connected = false;
  };

  const connectWs = () => {
    clearReconnect();
    stopWs();

    if (!token) {
      status.hasToken = false;
      status.connected = false;
      return;
    }

    status.hasToken = true;
    const url = new URL(wsBase);
    if (!url.searchParams.get('agentId')) {
      url.searchParams.set('agentId', agentId);
    }

    addLog(`Connecting to ${url.toString()}`);
    const wsConn = new WebSocket(url.toString(), {
      headers: {
        'x-agent-id': agentId,
        'x-agent-token': token,
      },
    });
    ws = wsConn;

    const heartbeatEveryMs = Math.max(
      5_000,
      Number.parseInt(String(process.env.AGENT_HEARTBEAT_MS || '').trim(), 10) || 25_000
    );
    const staleAfterMs = Math.max(
      heartbeatEveryMs * 2 + 10_000,
      Number.parseInt(String(process.env.AGENT_STALE_MS || '').trim(), 10) || 60_000
    );

    let lastInboundAt = Date.now();
    let idleHeartbeat: ReturnType<typeof setInterval> | null = null;
    let staleWatchdog: ReturnType<typeof setInterval> | null = null;

    const stopKeepalive = () => {
      if (idleHeartbeat) clearInterval(idleHeartbeat);
      if (staleWatchdog) clearInterval(staleWatchdog);
      idleHeartbeat = null;
      staleWatchdog = null;
    };

    const markInbound = () => {
      lastInboundAt = Date.now();
    };

    // Protocol-level keepalive from server (ws ping frames) does not show up as "message".
    wsConn.on('ping', () => {
      markInbound();
    });

    wsConn.on('pong', () => {
      markInbound();
    });

    wsConn.on('open', () => {
      status.connected = true;
      status.lastError = null;
      addLog('Connected');
      console.log(`[Agent] Connected agentId=${agentId} url=${url.toString()}`);

      markInbound();
      idleHeartbeat = setInterval(() => {
        if (wsConn.readyState !== WebSocket.OPEN) return;
        try {
          wsConn.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } catch {}
      }, heartbeatEveryMs);
      idleHeartbeat.unref?.();

      staleWatchdog = setInterval(() => {
        if (wsConn.readyState !== WebSocket.OPEN) return;
        const ageMs = Date.now() - lastInboundAt;
        if (ageMs <= staleAfterMs) return;
        addLog(`Stale WS (no inbound for ${Math.round(ageMs / 1000)}s). Reconnecting...`);
        try {
          wsConn.terminate();
        } catch {
          try {
            wsConn.close(1001, 'Stale');
          } catch {}
        }
      }, 15_000);
      staleWatchdog.unref?.();

      wsConn.send(
        JSON.stringify({
          type: 'hello',
          agentId,
          name: process.env.AGENT_NAME || undefined,
          version: process.env.AGENT_VERSION || '1',
          capabilities: { cart: true, addCart: true },
        })
      );
    });

    wsConn.on('message', async (raw) => {
      markInbound();
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = String(msg?.type || '');
      if (type === 'ping') {
        wsConn.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;
      }

      if (type !== 'rpc') return;

      const rpc = msg as RpcMessage;
      const requestId = String(rpc.requestId || '').trim();
      const method = String(rpc.method || '').trim();
      const params = (rpc.params || {}) as Record<string, unknown>;
      if (!requestId || !method) return;

      const sendProgress = (progress: any, log?: string) => {
        if (wsConn.readyState !== WebSocket.OPEN) return;
        wsConn.send(
          JSON.stringify({
            type: 'rpc_progress',
            requestId,
            progress,
            log,
          })
        );
      };

      const startHeartbeat = () => {
        const timer = setInterval(() => {
          if (wsConn.readyState !== WebSocket.OPEN) return;
          try {
            wsConn.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          } catch {}
        }, 10_000);
        timer.unref?.();
        return timer;
      };

      let heartbeat: ReturnType<typeof setInterval> | null = null;
      try {
        heartbeat = startHeartbeat();
        if (method === 'addAllSkusToCart') {
          const accountId = required('params.accountId', params.accountId as any);
          const taobaoId = required('params.taobaoId', params.taobaoId as any);
          const cookies = String((params.cookies as any) || '');

          const result = await autoCartAdder.addAllSkusToCart(accountId, taobaoId, cookies, {
            headless: false,
            onProgress: (progress, log) => sendProgress(progress, log),
          });

          wsConn.send(JSON.stringify({ type: 'rpc_result', requestId, ok: true, result }));
          return;
        }

        if (method === 'scrapeCart') {
          const accountId = required('params.accountId', params.accountId as any);
          const cookies = String((params.cookies as any) || '');
          const result = await cartScraper.scrapeCart(accountId, cookies);
          wsConn.send(JSON.stringify({ type: 'rpc_result', requestId, ok: true, result }));
          return;
        }

        wsConn.send(JSON.stringify({ type: 'rpc_result', requestId, ok: false, error: `Unknown method: ${method}` }));
      } catch (err: any) {
        wsConn.send(
          JSON.stringify({
            type: 'rpc_result',
            requestId,
            ok: false,
            error: err?.message ? String(err.message) : String(err),
          })
        );
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    });

    wsConn.on('close', (code, reason) => {
      stopKeepalive();
      status.connected = false;
      const why = String(reason || '');
      const errMsg = why || `WS closed (${code})`;
      status.lastError = errMsg;
      addLog(`Disconnected: code=${code} reason=${why}`);

      // Another instance (same agentId) took over this connection.
      // Avoid reconnect storms by stopping here.
      if (code === 1012) {
        addLog('This agent was replaced by a new connection. Stop reconnecting.');
        return;
      }

      const delay = 2000 + Math.floor(Math.random() * 3000);
      if (!token) return;
      reconnectTimer = setTimeout(connectWs, delay);
      reconnectTimer.unref?.();
    });

    wsConn.on('error', (err) => {
      const msg = err?.message ? String(err.message) : String(err);
      status.lastError = msg;
      addLog(`WS error: ${msg}`);
      console.warn(`[Agent] WS error agentId=${agentId}:`, err);
    });
  };

  const doPair = async (code: string) => {
    const normalized = String(code || '').trim();
    if (!normalized) throw new Error('Missing code');

    const newToken = await redeemPairCode({ wsBase, agentId, code: normalized });
    token = newToken;
    status.hasToken = true;
    status.lastError = null;

    await saveStoredAgentStore({ agentId, agentToken: token, createdAt: stored?.createdAt });
    addLog(`Paired successfully (saved token)`);
    console.log(`[Agent] Paired successfully and saved token to ${path.join(getAgentStoreDir(), 'agent.json')}`);

    if (!pairOnly) {
      connectWs();
    }
  };

  if (!token && pairCode) {
    await doPair(pairCode);
  }

  if (pairOnly) {
    if (!token) {
      throw new Error('Pair-only mode requires AGENT_TOKEN/API_KEY or --pair <CODE>.');
    }
    console.log('[Agent] Pair-only mode complete. Exiting.');
    return;
  }

  if (uiMode) {
    addLog('UI mode enabled');
    const resolvedPort = Number.isFinite(statusPort) && statusPort > 0 ? statusPort : 17880;
    const ui = await startStatusServer({ port: resolvedPort, logs: statusLogs, getStatus, pair: doPair });
    status.statusUrl = ui.url;

    if (!token) {
      addLog('Not paired yet. Waiting for pair code...');
      void ensureUiOpenedOnce(ui.url);
    } else {
      connectWs();
    }
    return;
  }

  if (!token) {
    throw new Error('Missing AGENT_TOKEN (or API_KEY). Use --pair <CODE> for first-time pairing.');
  }

  connectWs();
}

main().catch((err) => {
  const uiMode = isTruthy(process.env.AGENT_UI || process.env.AGENT_STATUS_UI);
  console.error('[Agent] Fatal:', err);
  if (!uiMode) process.exit(1);
});
