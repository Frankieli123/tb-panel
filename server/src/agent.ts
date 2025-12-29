import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { autoCartAdder } from './services/autoCartAdder.js';
import { cartScraper } from './services/cartScraper.js';

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

async function main(): Promise<void> {
  const agentId = await getOrCreateAgentId();
  const wsBase =
    String(process.env.AGENT_WS_URL || getArgValue('--ws') || '').trim() ||
    `ws://127.0.0.1:${process.env.PORT || '4000'}/ws/agent`;

  const envToken = String(process.env.AGENT_TOKEN || process.env.API_KEY || '').trim();
  const pairCode = String(process.env.AGENT_PAIR_CODE || getArgValue('--pair') || '').trim();

  const stored = await loadStoredAgentStore();
  const storedToken = String(stored?.agentToken || '').trim();

  let token = envToken || storedToken;
  if (!token && pairCode) {
    token = await redeemPairCode({ wsBase, agentId, code: pairCode });
    await saveStoredAgentStore({ agentId, agentToken: token, createdAt: stored?.createdAt });
    console.log(`[Agent] Paired successfully and saved token to ${path.join(getAgentStoreDir(), 'agent.json')}`);
  }

  if (!token) {
    throw new Error('Missing AGENT_TOKEN (or API_KEY). Use --pair <CODE> for first-time pairing.');
  }

  const url = new URL(wsBase);
  if (!url.searchParams.get('agentId')) {
    url.searchParams.set('agentId', agentId);
  }

  const connect = () => {
    const ws = new WebSocket(url.toString(), {
      headers: {
        'x-agent-id': agentId,
        'x-agent-token': token,
      },
    });

    ws.on('open', () => {
      console.log(`[Agent] Connected agentId=${agentId} url=${url.toString()}`);
      ws.send(
        JSON.stringify({
          type: 'hello',
          agentId,
          name: process.env.AGENT_NAME || undefined,
          version: process.env.AGENT_VERSION || '1',
          capabilities: { cart: true, addCart: true },
        })
      );
    });

    ws.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = String(msg?.type || '');
      if (type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;
      }

      if (type !== 'rpc') return;

      const rpc = msg as RpcMessage;
      const requestId = String(rpc.requestId || '').trim();
      const method = String(rpc.method || '').trim();
      const params = (rpc.params || {}) as Record<string, unknown>;
      if (!requestId || !method) return;

      const sendProgress = (progress: any, log?: string) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            type: 'rpc_progress',
            requestId,
            progress,
            log,
          })
        );
      };

      // 长任务心跳：避免后端 keepalive 误判“无消息”而 terminate 导致前端进度停滞
      const startHeartbeat = () => {
        const timer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
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

          ws.send(JSON.stringify({ type: 'rpc_result', requestId, ok: true, result }));
          return;
        }

        if (method === 'scrapeCart') {
          const accountId = required('params.accountId', params.accountId as any);
          const cookies = String((params.cookies as any) || '');
          const result = await cartScraper.scrapeCart(accountId, cookies);
          ws.send(JSON.stringify({ type: 'rpc_result', requestId, ok: true, result }));
          return;
        }

        ws.send(JSON.stringify({ type: 'rpc_result', requestId, ok: false, error: `Unknown method: ${method}` }));
      } catch (err: any) {
        ws.send(
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

    ws.on('close', (code, reason) => {
      console.warn(`[Agent] Disconnected agentId=${agentId} code=${code} reason=${String(reason || '')}`);
      const delay = 2000 + Math.floor(Math.random() * 3000);
      setTimeout(connect, delay).unref?.();
    });

    ws.on('error', (err) => {
      console.warn(`[Agent] WS error agentId=${agentId}:`, err);
    });
  };

  connect();
}

main().catch((err) => {
  console.error('[Agent] Fatal:', err);
  process.exit(1);
});
