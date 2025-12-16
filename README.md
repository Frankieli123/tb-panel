# 淘宝价格监控系统

一个用于监控淘宝商品价格的自动化工具，支持多账号、降价通知。

## 功能特性

- ✅ 多账号管理，分散抓取风险
- ✅ 自动获取登录后的"到手价"（券后价）
- ✅ 价格历史图表
- ✅ 降价通知（邮件/微信/Telegram）
- ✅ 响应式Web界面，支持手机访问
- ✅ Playwright + Stealth 反检测

## 技术栈

**后端**: Node.js + Express + TypeScript + Prisma + BullMQ
**前端**: React + Vite + TypeScript + Tailwind CSS
**数据库**: PostgreSQL + Redis
**爬虫**: Playwright

## 快速开始

### 1. 启动数据库

```bash
docker-compose up -d
```

### 2. 配置后端

```bash
cd server
cp .env.example .env
# 编辑 .env 配置数据库连接等

npm install
npx prisma migrate dev
npx playwright install chromium
npm run dev
```

### 3. 启动前端

```bash
cd client
npm install
npm run dev
```

访问 http://localhost:5173

### 4. 添加淘宝账号

1. 在"账号管理"页面点击"添加新账号"
2. 在服务器上运行登录脚本：
   ```bash
   cd server
   npx tsx src/scripts/login.ts --account=<accountId>
   ```
3. 在弹出的浏览器中扫码登录
4. 登录成功后按 Enter 保存 Cookie

### 5. 添加商品监控

在首页输入淘宝商品链接或ID即可开始监控。

## 配置说明

### 环境变量 (.env)

```env
# 数据库
DATABASE_URL="postgresql://taobao:taobao123@localhost:5432/taobao_tracker"

# Redis
REDIS_URL="redis://localhost:6379"

# 服务器端口
PORT=3000

# 邮件通知 (QQ邮箱为例)
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=your_email@qq.com
SMTP_PASS=your_smtp_password  # QQ邮箱需要授权码
SMTP_FROM=your_email@qq.com

# 微信通知 (Server酱)
WECHAT_WEBHOOK_URL=https://sctapi.ftqq.com/your_key.send

# 爬虫配置
SCRAPER_MIN_INTERVAL_MS=60000   # 最小间隔1分钟
SCRAPER_MAX_INTERVAL_MS=180000  # 最大间隔3分钟
MAX_CONCURRENT_ACCOUNTS=3       # 最大并发账号数
```

## 风险提示

1. **账号风险**: 请使用小号，不要使用主账号
2. **频率控制**: 系统已内置随机延迟，请勿修改为过于激进的频率
3. **合规性**: 本工具仅供个人学习研究使用

## 目录结构

```
taobao/
├── server/                 # 后端
│   ├── src/
│   │   ├── config/        # 配置
│   │   ├── controllers/   # API路由
│   │   ├── services/      # 业务逻辑
│   │   │   ├── scraper.ts    # 爬虫核心
│   │   │   ├── scheduler.ts  # 任务调度
│   │   │   └── notification.ts # 通知服务
│   │   ├── utils/         # 工具函数
│   │   └── scripts/       # 脚本
│   └── prisma/            # 数据库Schema
├── client/                # 前端
│   └── src/
│       ├── components/    # 组件
│       ├── pages/         # 页面
│       └── services/      # API调用
└── docker-compose.yml     # 数据库容器
```

## 常见问题

**Q: Cookie 多久过期？**
A: 一般1-2周，系统会在账号状态变为"需验证"时提醒你重新登录。

**Q: 为什么价格获取失败？**
A: 可能原因：
- Cookie 过期，需要重新登录
- 商品下架或链接无效
- 触发了淘宝风控，账号被暂时限制

**Q: 如何获取 Server酱 的 SendKey？**
A: 访问 https://sct.ftqq.com/ 使用微信登录即可获取。
