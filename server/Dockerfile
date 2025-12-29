# ==========================================
# 淘宝价格监控系统 - 后端 Dockerfile
# ==========================================
# 适用于：Dokploy / 中心后端（API + 调度）
# ==========================================

FROM node:20-alpine AS builder

WORKDIR /app

# 安装构建依赖
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

# 生成 Prisma Client
RUN npx prisma generate

# 复制源码并构建
COPY tsconfig.json ./
COPY src ./src/

RUN npm run build

# ==========================================
# Production Stage
# ==========================================
FROM node:20-alpine AS production

WORKDIR /app

# 安装生产依赖
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --omit=dev && \
    npx prisma generate && \
    npm cache clean --force

# 复制构建产物
COPY --from=builder /app/dist ./dist/

# 启动脚本（先运行迁移再启动服务）
COPY <<EOF /app/start.sh
#!/bin/sh
echo "Running database migrations..."
npx prisma migrate deploy
echo "Starting server..."
node dist/index.js
EOF

RUN chmod +x /app/start.sh

# 环境变量
ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

EXPOSE 4000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# 启动命令
CMD ["/app/start.sh"]
