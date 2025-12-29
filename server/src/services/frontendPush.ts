import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

/**
 * 前端实时推送服务
 * 用于向前端推送数据更新通知
 */
class FrontendPushService {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  initWebSocket(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[FrontendPush] Client connected, total=${this.clients.size}`);

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[FrontendPush] Client disconnected, total=${this.clients.size}`);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });

      // 发送欢迎消息
      ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    });

    console.log('[FrontendPush] WebSocket server initialized path=/ws/updates');
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = req.url || '';
    if (!url.startsWith('/ws/updates')) return false;
    if (!this.wss) return false;

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss!.emit('connection', ws, req);
    });
    return true;
  }

  /**
   * 推送商品数据更新通知
   */
  notifyProductUpdate(productId: string, data: {
    lastCheckAt: string;
    currentPrice?: number | null;
    title?: string | null;
  }): void {
    this.broadcast({
      type: 'product_update',
      productId,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * 推送任务状态更新
   */
  notifyTaskUpdate(jobId: string, status: string, progress?: any): void {
    this.broadcast({
      type: 'task_update',
      jobId,
      status,
      progress,
      timestamp: Date.now(),
    });
  }

  /**
   * 推送系统状态更新
   */
  notifySystemUpdate(): void {
    this.broadcast({
      type: 'system_update',
      timestamp: Date.now(),
    });
  }

  private broadcast(message: any): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}

export const frontendPush = new FrontendPushService();
