# 常用命令

## 启动服务

### 启动数据库 (Docker)
```bash
docker-compose up -d
```

### 后端开发服务器
```bash
cd server
npm run dev
```

### 前端开发服务器
```bash
cd client
npm run dev
```

## 数据库操作

### 运行数据库迁移
```bash
cd server
npx prisma migrate dev
```

### 生成 Prisma Client
```bash
cd server
npx prisma generate
```

### 打开 Prisma Studio (数据库GUI)
```bash
cd server
npx prisma studio
```

## 构建

### 构建后端
```bash
cd server
npm run build
```

### 构建前端
```bash
cd client
npm run build
```

## 安装依赖

### 后端依赖
```bash
cd server
npm install
```

### 前端依赖
```bash
cd client
npm install
```

### 安装 Playwright 浏览器
```bash
cd server
npx playwright install chromium
```

## 脚本

### 淘宝账号登录
```bash
cd server
npx tsx src/scripts/login.ts --account=<accountId>
```

## Windows 系统命令
- 列出目录: `dir` 或 `ls` (PowerShell)
- 查找文件: `dir /s /b filename` 或 `Get-ChildItem -Recurse`
- 搜索内容: `findstr /s /i "pattern" *.ts`
- Git: `git status`, `git diff`, `git log`

## 访问地址
- 前端: http://localhost:5173
- 后端 API: http://localhost:3000
- PostgreSQL: localhost:5432
- Redis: localhost:6379
