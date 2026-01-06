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
  monitorMode?: 'CART';
}

export interface InviteCode {
  id: string;
  code: string;
  isActive: boolean;
  disabledAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  usedAt: string | null;
  createdBy: { id: string; username: string; role: 'admin' | 'operator' } | null;
  usedBy: { id: string; username: string; role: 'admin' | 'operator' } | null;
}

export interface PriceSnapshot {
  id: string;
  finalPrice: number;
  originalPrice: number | null;
  capturedAt: string;
}

export interface SkuSelection {
  label: string;
  value: string;
  vid?: string;
}

export interface Variant {
  variantKey: string;
  skuId: string | null;
  skuProperties: string | null;
  vidPath: string;
  selections: SkuSelection[];
  finalPrice: number | null;
  originalPrice: number | null;
  thumbnailUrl: string | null;
  prevFinalPrice?: number | null;
  prevCapturedAt?: string | null;
}

export interface AgentInfo {
  agentId: string;
  name?: string;
  version?: string;
  capabilities?: Record<string, unknown>;
}

export interface AgentConnection {
  agentId: string;
  connectedAt: number;
  lastSeenAt: number;
  info: AgentInfo;
}

export interface AgentPairCode {
  code: string;
  expiresInSec: number;
}

export interface TaobaoAccount {
  id: string;
  name: string;
  agentId?: string | null;
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
  dingtalkEnabled: boolean;
  dingtalkWebhook: string | null;
  feishuEnabled: boolean;
  feishuWebhook: string | null;
  triggerType: 'AMOUNT' | 'PERCENT';
  triggerValue: number;
  notifyOnPriceUp: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  from: string;
  hasPass: boolean;
}

export interface WecomConfig {
  enabled: boolean;
  corpId: string;
  agentId: number;
  toUser: string;
  hasSecret: boolean;
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
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}
