export type ProductStatus = 'active' | 'updating' | 'error' | 'paused';

export interface PricePoint {
  date: string;
  price: number;
}

export interface Product {
  id: string;
  taobaoId: string;
  title: string | null;
  url: string;
  imageUrl: string | null;
  currentPrice: number | null;
  originalPrice: number | null;
  isActive: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  createdAt: string;
  snapshots: PriceSnapshot[];
  account?: { id: string; name: string } | null;
}

export interface PriceSnapshot {
  id: string;
  finalPrice: number;
  originalPrice: number | null;
  capturedAt: string;
}

export interface TaobaoAccount {
  id: string;
  name: string;
  isActive: boolean;
  status: 'IDLE' | 'RUNNING' | 'CAPTCHA' | 'LOCKED' | 'COOLDOWN';
  lastLoginAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  errorCount: number;
  createdAt: string;
  _count?: { products: number };
}

export interface NotificationConfig {
  id: string;
  emailEnabled: boolean;
  emailAddress: string | null;
  wechatEnabled: boolean;
  wechatWebhook: string | null;
  telegramEnabled: boolean;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  triggerType: 'AMOUNT' | 'PERCENT';
  triggerValue: number;
}

export interface SystemStatus {
  stats: {
    totalProducts: number;
    activeProducts: number;
    totalAccounts: number;
    activeAccounts: number;
    todaySnapshots: number;
  };
}

export interface ScraperConfig {
  id: string;
  minDelay: number;      // 最小延迟(秒)
  maxDelay: number;      // 最大延迟(秒)
  pollingInterval: number; // 轮询间隔(分钟)
}
