import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '4000', 10),
  apiKey: process.env.API_KEY || '', // 可选的API密钥认证

  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:5180')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  auth: {
    bootstrapInviteCode: process.env.BOOTSTRAP_INVITE_CODE || '',
    cookieDomain: process.env.COOKIE_DOMAIN || '',
    cookieSameSite: ((process.env.COOKIE_SAMESITE ||
      (process.env.NODE_ENV === 'production' ? 'none' : 'lax')) as 'lax' | 'none'),
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production',
    trustProxy: process.env.TRUST_PROXY === 'true',
    sessionTtlMs:
      parseInt(process.env.SESSION_TTL_DAYS || '1', 10) * 24 * 60 * 60 * 1000,
    rememberMeTtlMs:
      parseInt(process.env.REMEMBER_ME_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000,
  },

  database: {
    url: process.env.DATABASE_URL!,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  smtp: {
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },

  wechat: {
    webhookUrl: process.env.WECHAT_WEBHOOK_URL || '',
  },

  scraper: {
    minIntervalMs: parseInt(process.env.SCRAPER_MIN_INTERVAL_MS || '60000', 10),
    maxIntervalMs: parseInt(process.env.SCRAPER_MAX_INTERVAL_MS || '180000', 10),
    pageTimeoutMs: parseInt(process.env.SCRAPER_PAGE_TIMEOUT_MS || '30000', 10),
    maxConcurrentAccounts: parseInt(process.env.MAX_CONCURRENT_ACCOUNTS || '3', 10),
    // 浏览器数据存储目录
    userDataDir: path.join(process.cwd(), 'browser-data'),
  },
} as const;
