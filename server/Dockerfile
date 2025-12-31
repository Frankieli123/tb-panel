# ==========================================
# 淘宝价格监控系统 - 后端 Dockerfile
# ==========================================
# 适用于：Dokploy / 中心后端（API + 调度）
# ==========================================

FROM node:20-alpine AS builder

WORKDIR /app

# Prisma 在 Alpine 需要 `openssl` 可执行文件用于识别 OpenSSL 3.x
RUN apk add --no-cache openssl

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

# Prisma 在 Alpine 需要 `openssl` 可执行文件用于识别 OpenSSL 3.x
RUN apk add --no-cache openssl

# 安装生产依赖
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --omit=dev && \
    npx prisma generate && \
    npm cache clean --force

# 复制构建产物
COPY --from=builder /app/dist ./dist/

# 启动脚本（先运行迁移再启动服务）
COPY <<'EOF' /app/start.sh
#!/bin/sh
strip_outer_quotes() {
  v="$1"
  if [ "${v#\"}" != "$v" ] && [ "${v%\"}" != "$v" ]; then
    v="${v#\"}"
    v="${v%\"}"
  fi
  if [ "${v#\'}" != "$v" ] && [ "${v%\'}" != "$v" ]; then
    v="${v#\'}"
    v="${v%\'}"
  fi
  printf '%s' "$v"
}

if [ -n "${DATABASE_URL:-}" ]; then
  DATABASE_URL="$(strip_outer_quotes "$DATABASE_URL")"
  export DATABASE_URL
fi

if [ -n "${REDIS_URL:-}" ]; then
  REDIS_URL="$(strip_outer_quotes "$REDIS_URL")"
  export REDIS_URL
fi

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
    CMD wget -q --spider http://127.0.0.1:4000/health || exit 1

# 启动命令
CMD ["/app/start.sh"]
