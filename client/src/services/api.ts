import {
  InviteCode,
  NotificationConfig,
  PriceSnapshot,
  Product,
  ScraperConfig,
  SystemStatus,
  TaobaoAccount,
  Variant,
  SmtpConfig,
} from '../types';

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '';

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
  createInviteCode: () =>
    request<{ code: string }>('/auth/invite-codes', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({}),
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

  addProduct: (input: string, accountId?: string) =>
    request<Product>('/products', {
      method: 'POST',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
      body: JSON.stringify({ input, accountId }),
    }),

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
