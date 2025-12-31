import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function cleanEnv(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function normalizedEnv(name: string): string {
  const raw = process.env[name];
  const cleaned = cleanEnv(raw);
  if (raw !== undefined && cleaned !== raw) {
    process.env[name] = cleaned;
  }
  return cleaned;
}

function envString(name: string, fallback = ''): string {
  return normalizedEnv(name) || fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = normalizedEnv(name);
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = normalizedEnv(name);
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

const nodeEnv = envString('NODE_ENV', 'development');

export const config = {
  env: nodeEnv,
  host: envString('HOST', '127.0.0.1'),
  port: envInt('PORT', 4000),
  apiKey: envString('API_KEY'), // 可选的API密钥认证
  agent: {
    // Agent/WebWorker 连接到中心后端时使用的鉴权 token（优先于 API_KEY）
    token: envString('AGENT_TOKEN'),
  },

  cors: {
    origins: envString('CORS_ORIGINS', 'http://localhost:5180')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  auth: {
    bootstrapInviteCode: envString('BOOTSTRAP_INVITE_CODE'),
    cookieDomain: envString('COOKIE_DOMAIN'),
    cookieSameSite: (envString('COOKIE_SAMESITE', nodeEnv === 'production' ? 'none' : 'lax') as 'lax' | 'none'),
    cookieSecure: envBool('COOKIE_SECURE', nodeEnv === 'production'),
    trustProxy: envBool('TRUST_PROXY', false),
    sessionTtlMs:
      envInt('SESSION_TTL_DAYS', 1) * 24 * 60 * 60 * 1000,
    rememberMeTtlMs:
      envInt('REMEMBER_ME_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,
  },

  database: {
    url: envString('DATABASE_URL'),
  },

  redis: {
    url: envString('REDIS_URL'),
  },

  smtp: {
    host: envString('SMTP_HOST', 'smtp.qq.com'),
    port: envInt('SMTP_PORT', 465),
    user: envString('SMTP_USER'),
    pass: envString('SMTP_PASS'),
    from: envString('SMTP_FROM'),
  },

  wechat: {
    webhookUrl: envString('WECHAT_WEBHOOK_URL'),
  },

  scraper: {
    minIntervalMs: envInt('SCRAPER_MIN_INTERVAL_MS', 60000),
    maxIntervalMs: envInt('SCRAPER_MAX_INTERVAL_MS', 180000),
    pageTimeoutMs: envInt('SCRAPER_PAGE_TIMEOUT_MS', 30000),
    maxConcurrentAccounts: envInt('MAX_CONCURRENT_ACCOUNTS', 3),
    // 浏览器数据存储目录
    userDataDir: path.join(process.cwd(), 'browser-data'),
  },

  features: {
    // 先专注购物车模式时可关闭（避免启动 Playwright 详情页抓取链路）
    pageModeEnabled: false,
  },
} as const;
