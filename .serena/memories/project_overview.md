# 淘宝价格监控系统 (Taobao Price Tracker)

## 项目目的
一个用于监控淘宝商品价格的自动化工具，支持多账号管理、降价通知。

## 核心功能
- 多账号管理，分散抓取风险
- 自动获取登录后的"到手价"（券后价）
- 价格历史图表
- 降价通知（邮件/微信/Telegram）
- 响应式Web界面，支持手机访问
- Playwright + Stealth 反检测

## 技术栈

### 后端 (server/)
- Node.js + Express + TypeScript
- Prisma ORM (PostgreSQL)
- BullMQ (Redis 任务队列)
- Playwright (爬虫)
- Zod (数据验证)
- WebSocket (实时通信)

### 前端 (client/)
- React 18 + TypeScript
- Vite (构建工具)
- Tailwind CSS (样式)
- React Router v7
- Recharts (图表)
- Lucide React (图标)

### 基础设施
- PostgreSQL 16 (数据库)
- Redis 7 (缓存/队列)
- Docker Compose (容器编排)

## 项目结构
```
taobao/
├── server/                 # 后端
│   ├── src/
│   │   ├── config/        # 配置
│   │   ├── controllers/   # API路由
│   │   ├── services/      # 业务逻辑
│   │   ├── jobs/          # 后台任务
│   │   ├── middlewares/   # 中间件
│   │   ├── models/        # 数据模型
│   │   ├── utils/         # 工具函数
│   │   └── scripts/       # 脚本
│   └── prisma/            # 数据库Schema
├── client/                # 前端
│   └── src/
│       ├── components/    # 组件
│       ├── pages/         # 页面
│       ├── hooks/         # 自定义Hooks
│       ├── services/      # API调用
│       ├── types/         # 类型定义
│       └── assets/        # 静态资源
└── docker-compose.yml     # 数据库容器
```

## 数据模型
- TaobaoAccount: 淘宝账号管理
- Product: 商品信息
- PriceSnapshot: 价格快照（历史记录）
- NotificationConfig: 通知配置
- NotificationLog: 通知记录
- SystemConfig: 系统配置
