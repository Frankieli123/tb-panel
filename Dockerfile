# ==========================================
# 淘宝价格监控系统 - 全栈 Dockerfile
# ==========================================
# 前端 + 后端一体化部署
# ==========================================

# 默认使用镜像源，降低 `npm ci` 在部分网络环境下的 ETIMEDOUT 概率。
# 如需改回官方源：docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_REGISTRY=https://registry.npmmirror.com/

# ==========================================
# Stage 1: 构建前端
# ==========================================
FROM node:20-alpine AS frontend-builder
ARG NPM_REGISTRY

WORKDIR /app/client

COPY client/package*.json ./
RUN sed -i "s#https://registry.npmjs.org/#${NPM_REGISTRY%/}/#g" package-lock.json 2>/dev/null || true && \
    npm config set registry "${NPM_REGISTRY%/}/" && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-timeout 600000 && \
    npm ci --no-audit --no-fund

COPY client/ ./
RUN npm run build

# ==========================================
# Stage 2: 构建后端
# ==========================================
FROM node:20-alpine AS backend-builder
ARG NPM_REGISTRY

WORKDIR /app/server

RUN apk add --no-cache openssl

COPY server/package*.json ./
COPY server/prisma ./prisma/

RUN sed -i "s#https://registry.npmjs.org/#${NPM_REGISTRY%/}/#g" package-lock.json 2>/dev/null || true && \
    npm config set registry "${NPM_REGISTRY%/}/" && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-timeout 600000 && \
    npm ci --no-audit --no-fund
RUN npx prisma generate

COPY server/tsconfig.json ./
COPY server/src ./src/

RUN npm run build

# ==========================================
# Stage 3: 生产镜像
# ==========================================
FROM node:20-alpine AS production
ARG NPM_REGISTRY

RUN apk add --no-cache nginx supervisor openssl tzdata chromium

# 安装 nginx、supervisor，并提供 `openssl` 可执行文件供 Prisma 检测 OpenSSL 版本
# tzdata 用于支持 TZ 时区（静默时间等按本地时间计算的功能）

WORKDIR /app

# 后端依赖
COPY server/package*.json ./server/
COPY server/prisma ./server/prisma/

WORKDIR /app/server
RUN sed -i "s#https://registry.npmjs.org/#${NPM_REGISTRY%/}/#g" package-lock.json 2>/dev/null || true && \
    npm config set registry "${NPM_REGISTRY%/}/" && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-timeout 600000 && \
    npm ci --omit=dev --no-audit --no-fund && \
    npx prisma generate && \
    npm cache clean --force

# 复制后端构建产物
COPY --from=backend-builder /app/server/dist ./dist/

# 复制前端构建产物到 nginx
COPY --from=frontend-builder /app/client/dist /usr/share/nginx/html

# 创建 nginx 配置目录并写入配置（Alpine nginx: http.d 在 http{} 内被 include）
RUN mkdir -p /etc/nginx/http.d

COPY <<'EOF' /etc/nginx/http.d/default.conf
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /health {
        proxy_pass http://127.0.0.1:4000/health;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:4000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_read_timeout 86400;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

# Alpine 的 `/etc/nginx/conf.d/*.conf` 会在 root context 被 include（不能放 `server {}`），确保目录为空
RUN rm -f /etc/nginx/conf.d/default.conf 2>/dev/null || true

# Supervisor 配置
COPY <<'EOF' /etc/supervisord.conf
[supervisord]
nodaemon=true
logfile=/var/log/supervisord.log
pidfile=/var/run/supervisord.pid

[program:nginx]
command=nginx -g "daemon off;"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:backend]
command=node /app/server/dist/index.js
directory=/app/server
environment=NODE_ENV="production",PORT="4000",HOST="0.0.0.0"
autostart=true
autorestart=true
startsecs=5
startretries=3
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
EOF

# 启动脚本
COPY <<'EOF' /app/start.sh
#!/bin/sh
cd /app/server

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
echo "Starting services..."
exec supervisord -c /etc/supervisord.conf
EOF

RUN chmod +x /app/start.sh

# 环境变量
ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# 暴露端口（nginx 80，后端 4000 仅内部使用）
EXPOSE 80

# 健康检查（直接检查后端）
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:4000/health || exit 1

WORKDIR /app

CMD ["/app/start.sh"]
