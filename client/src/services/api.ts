import { PriceSnapshot, Product, ScraperConfig, SystemStatus, TaobaoAccount, NotificationConfig, Variant } from '../types';

const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data.data;
}

export const api = {
  // 商品
  getProducts: () => request<Product[]>('/products'),

  addProduct: (input: string, accountId?: string) =>
    request<Product>('/products', {
      method: 'POST',
      body: JSON.stringify({ input, accountId }),
    }),

  deleteProduct: (id: string) =>
    request<void>(`/products/${id}`, { method: 'DELETE' }),

  refreshProduct: (id: string) =>
    request<void>(`/products/${id}/refresh`, { method: 'POST' }),

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
      body: JSON.stringify({ name }),
    }),

  deleteAccount: (id: string) =>
    request<void>(`/accounts/${id}`, { method: 'DELETE' }),

  toggleAccount: (id: string) =>
    request<void>(`/accounts/${id}/toggle`, { method: 'PUT' }),

  updateAccountCookies: (id: string, cookies: string) =>
    request<void>(`/accounts/${id}/cookies`, {
      method: 'PUT',
      body: JSON.stringify({ cookies }),
    }),

  // 通知
  getNotificationConfig: () => request<NotificationConfig>('/notifications/config'),

  updateNotificationConfig: (config: Partial<NotificationConfig>) =>
    request<NotificationConfig>('/notifications/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  testNotification: (channel: string, config: any) =>
    fetch(`${API_BASE}/notifications/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, ...config }),
    }).then((r) => r.json()),

  // 系统
  getSystemStatus: () => request<SystemStatus>('/system/status'),

  startScheduler: () =>
    request<void>('/system/scheduler/start', { method: 'POST' }),

  stopScheduler: () =>
    request<void>('/system/scheduler/stop', { method: 'POST' }),

  // 抓取配置
  getScraperConfig: () => request<ScraperConfig>('/scraper/config'),

  updateScraperConfig: (config: Partial<ScraperConfig>) =>
    request<ScraperConfig>('/scraper/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
};
