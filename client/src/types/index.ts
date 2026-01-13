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
  role: 'admin' | 'operator';
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

export interface BrowserSession {
  accountId: string;
  lastUsedAt: number;
  pageClosed: boolean;
  url: string | null;
}

export interface BrowserStatus {
  agentId: string;
  now: number;
  connected: boolean;
  lastError: string | null;
  sessions: BrowserSession[];
}

export interface BrowserScreenshot {
  agentId: string;
  accountId: string;
  now: number;
  image: string; // base64 jpeg
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
  cartSkuTotal?: number | null;
  cartSkuLoaded?: number | null;
  cartSkuUpdatedAt?: string | null;
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
  humanDelayScale: number; // 人类操作延迟缩放（<1 更快，>1 更慢）
  cartAddSkuLimit: number; // 加购：每商品随机 SKU 数（0=全部）
  cartAddSkuDelayMinMs: number; // 加购：SKU 间隔最小(ms)
  cartAddSkuDelayMaxMs: number; // 加购：SKU 间隔最大(ms)
  cartAddProductDelayMinMs: number; // 加购：商品开始间隔最小(ms)
  cartAddProductDelayMaxMs: number; // 加购：商品开始间隔最大(ms)
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}
