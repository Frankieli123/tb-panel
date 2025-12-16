import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import apiRouter from './controllers/api.js';
import { schedulerService } from './services/scheduler.js';
import { loginManager } from './services/loginManager.js';

const app = express();

// 中间件
app.use(cors());
app.use(express.json());

// API路由
app.use('/api', apiRouter);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 启动服务器
const server = app.listen(config.port, () => {
  console.log(`[Server] Running on http://localhost:${config.port}`);
  console.log(`[Server] Environment: ${config.env}`);

  // 初始化 WebSocket 服务（用于扫码登录）
  loginManager.initWebSocket(server);

  // 自动启动调度器
  if (config.env !== 'test') {
    schedulerService.start().catch(console.error);
  }
});

// 优雅关闭
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received, shutting down...');
  await schedulerService.stop();
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT received, shutting down...');
  await schedulerService.stop();
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});
