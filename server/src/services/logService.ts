import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
}

/**
 * 日志服务 - 收集并推送日志到前端
 */
class LogService {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private logs: LogEntry[] = [];
  private maxLogs = 1000; // 内存中保留最近 1000 条日志
  private idCounter = 0;

  // 保存原始 console 方法
  private originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  initWebSocket(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[LogService] 客户端已连接，当前总数=${this.clients.size}`);

      // 发送最近的日志历史
      ws.send(JSON.stringify({ type: 'history', logs: this.logs.slice(-100) }));

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[LogService] 客户端已断开，当前总数=${this.clients.size}`);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    // 劫持 console 方法
    this.interceptConsole();

    console.log('[LogService] 服务已启动(WebSocket) path=/ws/logs');
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = req.url || '';
    if (!url.startsWith('/ws/logs')) return false;
    if (!this.wss) return false;

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss!.emit('connection', ws, req);
    });
    return true;
  }

  private interceptConsole(): void {
    // 劫持 console.log
    console.log = (...args: any[]) => {
      this.originalConsole.log(...args);
      this.addLog('info', this.formatArgs(args));
    };

    // 劫持 console.warn
    console.warn = (...args: any[]) => {
      this.originalConsole.warn(...args);
      this.addLog('warn', this.formatArgs(args));
    };

    // 劫持 console.error
    console.error = (...args: any[]) => {
      this.originalConsole.error(...args);
      this.addLog('error', this.formatArgs(args));
    };
  }

  private formatArgs(args: any[]): string {
    return args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(' ');
  }

  private addLog(level: LogEntry['level'], message: string): void {
    // 解析来源（从 [xxx] 格式提取）
    const sourceMatch = message.match(/^\[([^\]]+)\]/);
    const source = sourceMatch ? sourceMatch[1] : 'System';

    const entry: LogEntry = {
      id: `log_${++this.idCounter}`,
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
    };

    // 添加到内存
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // 推送给所有连接的客户端
    this.broadcast({ type: 'log', log: entry });
  }

  private broadcast(message: any): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // 获取历史日志
  getLogs(options?: { level?: string; limit?: number; search?: string }): LogEntry[] {
    let result = [...this.logs];

    if (options?.level && options.level !== 'all') {
      result = result.filter(log => log.level === options.level);
    }

    if (options?.search) {
      const query = options.search.toLowerCase();
      result = result.filter(log => 
        log.message.toLowerCase().includes(query) ||
        log.source.toLowerCase().includes(query)
      );
    }

    if (options?.limit) {
      result = result.slice(-options.limit);
    }

    return result;
  }
}

export const logService = new LogService();
