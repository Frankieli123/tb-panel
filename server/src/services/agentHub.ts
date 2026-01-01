import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config/index.js';
import { agentAuthService } from './agentAuth.js';

type AgentInfo = {
  agentId: string;
  name?: string;
  version?: string;
  capabilities?: Record<string, unknown>;
};

type AgentConnection = {
  agentId: string;
  userId: string | null;
  ws: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  info: AgentInfo;
};

type RpcProgress = {
  total: number;
  current: number;
  success: number;
  failed: number;
};

type PendingRpc = {
  agentId: string;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
  onProgress?: (progress: RpcProgress, log?: string) => void;
};

function getProvidedToken(req: IncomingMessage): string {
  const headerToken = String(req.headers['x-agent-token'] || '');
  if (headerToken) return headerToken;

  const auth = String(req.headers['authorization'] || '');
  return auth.replace(/^Bearer\s+/i, '').trim();
}

function getAgentIdFromReq(req: IncomingMessage): string {
  const headerAgentId = String(req.headers['x-agent-id'] || '').trim();
  if (headerAgentId) return headerAgentId;

  const base = `http://${req.headers.host || 'localhost'}`;
  const url = new URL(String(req.url || ''), base);
  return String(url.searchParams.get('agentId') || '').trim();
}

export class AgentHub {
  private wss: WebSocketServer | null = null;
  private agents = new Map<string, AgentConnection>();
  private pending = new Map<string, PendingRpc>();

  initWebSocket(_server: any): void {
    // Use noServer mode so multiple WS endpoints can share one HTTP server
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws, req) => {
      void this.handleConnection(ws, req).catch((err) => {
        console.warn('[AgentHub] Failed to handle connection:', err);
        try {
          ws.close(1011, 'Internal error');
        } catch {}
      });
    });

    // Keepalive: protocol-level ping/pong (more standard than JSON ping/pong).
    const pingIntervalMs = Math.max(
      5_000,
      Number.parseInt(String(process.env.AGENT_HUB_PING_MS || '').trim(), 10) || 25_000
    );
    const staleAfterMs = Math.max(
      pingIntervalMs * 4,
      Number.parseInt(String(process.env.AGENT_HUB_STALE_MS || '').trim(), 10) || 120_000
    );

    setInterval(() => {
      const now = Date.now();
      for (const conn of this.agents.values()) {
        // 长任务（RPC）期间，Agent 可能长时间不回消息（例如在单个 SKU 内卡住/等待 UI），
        // 这里如果直接 terminate 会导致前端进度“卡在前几个成功数”。
        const hasPending = Array.from(this.pending.values()).some((p) => p.agentId === conn.agentId);
        if (!hasPending && now - conn.lastSeenAt > staleAfterMs) {
          try {
            conn.ws.terminate();
          } catch {}
          this.agents.delete(conn.agentId);
          continue;
        }
        try {
          conn.ws.ping();
        } catch {}
      }
    }, pingIntervalMs).unref?.();

    console.log('[AgentHub] WebSocket server initialized path=/ws/agent');
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const agentId = getAgentIdFromReq(req);
    if (!agentId) {
      ws.close(1008, 'Missing agentId');
      return;
    }

    const providedToken = getProvidedToken(req);
    if (!providedToken) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    let userId: string | null = null;
    const staticToken = String(config.agent.token || config.apiKey || '').trim();

    if (staticToken && providedToken === staticToken) {
      userId = null; // shared/system token (backward compatible)
    } else {
      const verified = await agentAuthService.verifyAgentToken(agentId, providedToken);
      if (!verified) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      userId = verified.userId;
    }

    const existing = this.agents.get(agentId);
    if (existing) {
      try {
        existing.ws.close(1012, 'Replaced by new connection');
      } catch {}
      this.agents.delete(agentId);
    }

    const now = Date.now();
    const conn: AgentConnection = {
      agentId,
      userId,
      ws,
      connectedAt: now,
      lastSeenAt: now,
      info: { agentId },
    };
    this.agents.set(agentId, conn);
    console.log(`[AgentHub] Agent connected agentId=${agentId} userId=${userId ?? 'shared'}`);

      ws.on('pong', () => {
        conn.lastSeenAt = Date.now();
      });

      ws.on('ping', () => {
        conn.lastSeenAt = Date.now();
      });

      ws.on('message', (raw) => {
        conn.lastSeenAt = Date.now();

        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const type = String(msg?.type || '');
        if (type === 'hello') {
          conn.info = {
            agentId,
            name: typeof msg?.name === 'string' ? msg.name : conn.info.name,
            version: typeof msg?.version === 'string' ? msg.version : conn.info.version,
            capabilities: typeof msg?.capabilities === 'object' ? msg.capabilities : conn.info.capabilities,
          };
          return;
        }

        if (type === 'pong') {
          return;
        }

        if (type === 'rpc_progress') {
          const requestId = String(msg?.requestId || '');
          const pending = this.pending.get(requestId);
          if (!pending?.onProgress) return;
          const p = msg?.progress as RpcProgress;
          const log = typeof msg?.log === 'string' ? msg.log : undefined;
          if (
            p &&
            typeof p.total === 'number' &&
            typeof p.current === 'number' &&
            typeof p.success === 'number' &&
            typeof p.failed === 'number'
          ) {
            pending.onProgress(p, log);
          }
          return;
        }

        if (type === 'rpc_result') {
          const requestId = String(msg?.requestId || '');
          const pending = this.pending.get(requestId);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.pending.delete(requestId);

          if (msg?.ok) {
            pending.resolve(msg?.result);
          } else {
            pending.reject(new Error(String(msg?.error || 'Agent RPC failed')));
          }
          return;
        }
      });

      ws.on('close', () => {
        const current = this.agents.get(agentId);
        if (current?.ws === ws) {
          this.agents.delete(agentId);
        }

        for (const [requestId, pending] of this.pending.entries()) {
          if (pending.agentId !== agentId) continue;
          clearTimeout(pending.timeout);
          pending.reject(new Error(`Agent disconnected agentId=${agentId}`));
          this.pending.delete(requestId);
        }

        console.log(`[AgentHub] Agent disconnected agentId=${agentId}`);
      });

      ws.on('error', (err) => {
        console.warn(`[AgentHub] Agent ws error agentId=${agentId}:`, err);
      });
  }

  /**
   * Route HTTP upgrade requests to this WS server.
   * Returns true when the upgrade is handled.
   */
  handleUpgrade(req: any, socket: any, head: any): boolean {
    if (!this.wss) return false;
    try {
      const base = `http://${req.headers.host || 'localhost'}`;
      const url = new URL(String(req.url || ''), base);
      if (url.pathname !== '/ws/agent') return false;
    } catch {
      return false;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit('connection', ws, req);
    });
    return true;
  }

  listConnectedAgents(): Array<{
    agentId: string;
    userId: string | null;
    connectedAt: number;
    lastSeenAt: number;
    info: AgentInfo;
  }> {
    return Array.from(this.agents.values()).map((a) => ({
      agentId: a.agentId,
      userId: a.userId,
      connectedAt: a.connectedAt,
      lastSeenAt: a.lastSeenAt,
      info: a.info,
    }));
  }

  isOwnedBy(agentId: string, userId: string | null): boolean {
    const conn = this.agents.get(agentId);
    if (!conn) return false;
    if (conn.userId === null) return true; // shared/system agent
    return conn.userId === userId;
  }

  isConnected(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  async call<T>(
    agentId: string,
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number; onProgress?: (progress: RpcProgress, log?: string) => void }
  ): Promise<T> {
    const conn = this.agents.get(agentId);
    if (!conn) {
      throw new Error(`Agent not connected: ${agentId}`);
    }

    const requestId = randomUUID();
    const timeoutMs = Math.max(3_000, options?.timeoutMs ?? 120_000);

    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Agent RPC timeout: ${method} agentId=${agentId}`));
      }, timeoutMs);

      this.pending.set(requestId, { agentId, resolve, reject, timeout, onProgress: options?.onProgress });
    });

    conn.ws.send(
      JSON.stringify({
        type: 'rpc',
        requestId,
        method,
        params,
      })
    );

    return result;
  }
}

export const agentHub = new AgentHub();
