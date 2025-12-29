import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import apiRouter from './controllers/api.js';
import cartApiRouter from './controllers/cartApi.js';
import { schedulerService } from './services/scheduler.js';
import { loginManager } from './services/loginManager.js';
import { chromeLauncher } from './services/chromeLauncher.js';
import { agentHub } from './services/agentHub.js';
import { frontendPush } from './services/frontendPush.js';
import { logService } from './services/logService.js';

const app = express();

// 中间件
if ((config as any).auth?.trustProxy) {
  app.set('trust proxy', 1);
}

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = (config as any).cors?.origins as string[] | undefined;
      if (!origin) {
        callback(null, true);
        return;
      }

      if (!allowed || allowed.includes(origin)) {
        callback(null, true);
        return;
      }

      if (
        config.env !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(express.json());

// API路由
app.use('/api', apiRouter);
app.use('/api', cartApiRouter);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 启动服务器
const server = app.listen(config.port, config.host, async () => {
  console.log(`[Server] Running on http://${config.host}:${config.port}`);
  console.log(`[Server] Environment: ${config.env}`);

  // 初始化 WebSocket 服务（用于扫码登录）
  loginManager.initWebSocket(server);
  agentHub.initWebSocket(server);
  frontendPush.initWebSocket(server);
  logService.initWebSocket(server);

  // 购物车/加购相关功能会按需拉起 Chrome（避免启动即占用资源）
  console.log('[Server] Chrome for cart mode will be launched on-demand');

  // 自动启动调度器
  if (config.env !== 'test') {
    schedulerService.start().catch(console.error);
  }
});

// WebSocket upgrade routing (login + agent + frontend + logs share one HTTP server)
server.on('upgrade', (req: any, socket: any, head: any) => {
  try {
    if (loginManager.handleUpgrade(req, socket, head)) return;
    if (agentHub.handleUpgrade(req, socket, head)) return;
    if (frontendPush.handleUpgrade(req, socket, head)) return;
    if (logService.handleUpgrade(req, socket, head)) return;
  } catch {}

  try {
    socket.destroy();
  } catch {}
});

server.on('error', (error: any) => {
  if (error?.code === 'EACCES') {
    console.error(
      `[Server] Permission denied listening on ${config.host}:${config.port}. ` +
        `On Windows this is often caused by excluded port ranges. Try setting a different PORT (e.g. 3100/4000).`
    );
    return;
  }
  if (error?.code === 'EADDRINUSE') {
    console.error(
      `[Server] Port already in use: ${config.host}:${config.port}. ` +
        `Try a different PORT or stop the process currently using it.`
    );
    return;
  }
  console.error('[Server] Server error:', error);
});

// 优雅关闭
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received, shutting down...');
  await schedulerService.stop();
  await chromeLauncher.kill(); // 关闭 Chrome 实例
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT received, shutting down...');
  await schedulerService.stop();
  await chromeLauncher.kill(); // 关闭 Chrome 实例
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});
