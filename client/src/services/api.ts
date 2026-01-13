import type {
  InviteCode,
  NotificationConfig,
  PriceSnapshot,
  Product,
  ScraperConfig,
  SystemStatus,
  TaobaoAccount,
  Variant,
  SmtpConfig,
  WecomConfig,
  AgentConnection,
  AgentPairCode,
  BrowserScreenshot,
  BrowserStatus,
} from '../types';

const API_ORIGIN = import.meta.env.DEV ? '' : ((import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '');

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  if (base.endsWith('/') && path.startsWith('/')) return `${base.slice(0, -1)}${path}`;
  if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
  return `${base}${path}`;
}

const API_BASE = joinUrl(API_ORIGIN, '/api');

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getLoginWsUrl(): string {
  const wsOrigin =
    ((import.meta.env.VITE_WS_ORIGIN as string | undefined) ?? '') ||
    API_ORIGIN ||
    window.location.origin;

  const protocol = wsOrigin.startsWith('https://') ? 'wss://' : 'ws://';
  const host = wsOrigin.replace(/^https?:\/\//, '');
  return `${protocol}${host}/ws/login`;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const mergedHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers ? (options.headers as Record<string, string>) : {}),
  };

  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: mergedHeaders,
    credentials: 'include',
  });

  if (response.status === 401) {
    window.dispatchEvent(new Event('auth:unauthorized'));
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data.data;
}

export const api = {
  authMe: () => request<any>('/auth/me'),
  login: (username: string, password: string, rememberMe: boolean) =>
    request<void>('/auth/login', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ username, password, rememberMe }),
    }),
  register: (username: string, password: string, inviteCode: string) =>
    request<void>('/auth/register', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ username, password, inviteCode }),
    }),
  logout: () =>
    request<void>('/auth/logout', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({}),
    }),

  listInviteCodes: () => request<InviteCode[]>('/auth/invite-codes'),
  createInviteCode: (role: 'admin' | 'operator' = 'operator') =>
    request<{ code: string }>('/auth/invite-codes', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ role }),
    }),
  disableInviteCode: (id: string) =>
    request<void>(`/auth/invite-codes/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({}),
    }),
  deleteInviteCode: (id: string) =>
    request<void>(`/auth/invite-codes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
    }),

  // 商品
  getProducts: () => request<Product[]>('/products'),

  addCartModeProduct: (url: string, accountId?: string, useAccountPool?: boolean, cartAddSkuLimit?: number) =>
    request<{ jobId: string }>('/products/add-cart-mode', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify(
        (() => {
          const body: any = useAccountPool ? { url, useAccountPool: true } : { url, accountId };
          if (cartAddSkuLimit !== undefined) body.cartAddSkuLimit = cartAddSkuLimit;
          return body;
        })()
      ),
    }),

  addBatchCartModeProducts: (urls: string[], accountId?: string, useAccountPool?: boolean, cartAddSkuLimit?: number) =>
    request<{ batchJobId: string; accepted: number; rejected: number }>('/products/batch-add-cart-mode', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify(
        (() => {
          const body: any = useAccountPool ? { urls, useAccountPool: true } : { urls, accountId };
          if (cartAddSkuLimit !== undefined) body.cartAddSkuLimit = cartAddSkuLimit;
          return body;
        })()
      ),
    }),

  getBatchAddProgress: (batchJobId: string) =>
    request<{
      status: 'running' | 'completed' | 'failed' | 'partial';
      progress: { totalItems: number; currentIndex: number; completedItems: number; successItems: number; failedItems: number };
      items: Array<{
        index: number;
        url: string;
        taobaoId?: string;
        status: 'pending' | 'running' | 'completed' | 'failed';
        progress?: { total: number; current: number; success: number; failed: number };
        logs: string[];
        error?: string;
        productId?: string;
      }>;
    }>(`/products/batch-add-progress/${batchJobId}`),

  getAddProgress: (jobId: string) =>
    request<{
      status: 'pending' | 'running' | 'completed' | 'failed';
      progress: { total: number; current: number; success: number; failed: number };
      logs: string[];
    }>(`/products/add-progress/${jobId}`),

  deleteProduct: (id: string) =>
    request<void>(`/products/${id}`, {
      method: 'DELETE',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
    }),

  refreshProduct: (id: string) =>
    request<void>(`/products/${id}/refresh`, {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({}),
    }),

  getProductVariantsLatest: (id: string) =>
    request<Variant[]>(`/products/${id}/variants/latest`),

  getVariantHistory: (id: string, variantKey: string, days = 30) =>
    request<PriceSnapshot[]>(`/products/${id}/variants/${encodeURIComponent(variantKey)}/history?days=${days}`),

  getProductHistory: (id: string, days = 30) =>
    request<PriceSnapshot[]>(`/products/${id}/history?days=${days}`),

  // 账号
  getAccounts: () => request<TaobaoAccount[]>('/accounts'),
  getAgents: () => request<AgentConnection[]>('/agents'),
  getAgentBrowserStatus: (agentId: string) =>
    request<BrowserStatus>(`/agents/${encodeURIComponent(agentId)}/browser-status`),
  getAccountBrowserScreenshot: (accountId: string) =>
    request<BrowserScreenshot>(`/accounts/${encodeURIComponent(accountId)}/browser-screenshot`),
  createAgentPairCode: (setAsDefault?: boolean) =>
    request<AgentPairCode>('/agents/pair-code', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ setAsDefault }),
    }),

  addAccount: (name: string) =>
    request<TaobaoAccount>('/accounts', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ name }),
    }),

  deleteAccount: (id: string) =>
    request<void>(`/accounts/${id}`, {
      method: 'DELETE',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
    }),

  toggleAccount: (id: string) =>
    request<void>(`/accounts/${id}/toggle`, {
      method: 'PUT',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({}),
    }),

  updateAccountCookies: (id: string, cookies: string) =>
    request<void>(`/accounts/${id}/cookies`, {
      method: 'PUT',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ cookies }),
    }),

  updateAccountAgent: (id: string, agentId: string | null) =>
    request<void>(`/accounts/${id}/agent`, {
      method: 'PUT',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ agentId }),
    }),

  updateMyPreferredAgent: (agentId: string | null) =>
    request<void>('/me/preferred-agent', {
      method: 'PUT',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ agentId }),
    }),

  // 通知
  getNotificationConfig: () => request<NotificationConfig>('/notifications/config'),

  updateNotificationConfig: (config: Partial<NotificationConfig>) =>
    request<NotificationConfig>('/notifications/config', {
      method: 'PUT',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify(config),
    }),

  testNotification: (channel: string, config: any) =>
    fetch(`${API_BASE}/notifications/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ channel, ...config }),
    }).then((r) => {
      if (r.status === 401) {
        window.dispatchEvent(new Event('auth:unauthorized'));
      }
      return r.json();
    }),

  getSmtpConfig: () => request<SmtpConfig>('/notifications/smtp'),

  updateSmtpConfig: (config: Partial<{ host: string; port: number; user: string; pass: string; from: string }>) =>
    request<SmtpConfig>('/notifications/smtp', {
      method: 'PUT',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify(config),
    }),

  testSmtp: (to: string) =>
    fetch(`${API_BASE}/notifications/smtp/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ to }),
    }).then((r) => {
      if (r.status === 401) {
        window.dispatchEvent(new Event('auth:unauthorized'));
      }
      return r.json();
    }),

  getWecomConfig: () => request<WecomConfig>('/notifications/wecom'),

  updateWecomConfig: (config: Partial<{ enabled: boolean; corpId: string; agentId: number; secret: string; toUser: string }>) =>
    request<WecomConfig>('/notifications/wecom', {
      method: 'PUT',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify(config),
    }),

  testWecom: () =>
    fetch(`${API_BASE}/notifications/wecom/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({}),
    }).then((r) => {
      if (r.status === 401) {
        window.dispatchEvent(new Event('auth:unauthorized'));
      }
      return r.json();
    }),

  // 系统
  getSystemStatus: () => request<SystemStatus>('/system/status'),

  startScheduler: () =>
    request<void>('/system/scheduler/start', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({}),
    }),

  stopScheduler: () =>
    request<void>('/system/scheduler/stop', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({}),
    }),

  // 抓取配置
  getScraperConfig: () => request<ScraperConfig>('/scraper/config'),

  updateScraperConfig: (config: Partial<ScraperConfig>) =>
    request<ScraperConfig>('/scraper/config', {
      method: 'PUT',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify(config),
    }),
};
