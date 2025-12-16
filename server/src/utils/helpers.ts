import { randomInt } from 'crypto';

/**
 * 生成随机延迟时间（毫秒）
 */
export function randomDelay(minMs: number, maxMs: number): number {
  return randomInt(minMs, maxMs + 1);
}

/**
 * 睡眠指定毫秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 从淘宝URL中提取商品ID
 */
export function extractTaobaoId(input: string): string | null {
  // 支持多种格式:
  // 1. 纯ID: 123456789
  // 2. 完整URL: https://item.taobao.com/item.htm?id=123456789
  // 3. 短链接: https://m.tb.cn/xxx
  // 4. 手淘分享链接

  // 纯数字
  if (/^\d{10,15}$/.test(input.trim())) {
    return input.trim();
  }

  // URL中提取id参数
  const idMatch = input.match(/[?&]id=(\d+)/);
  if (idMatch) {
    return idMatch[1];
  }

  // 天猫URL
  const tmallMatch = input.match(/detail\.tmall\.com\/item\.htm.*[?&]id=(\d+)/);
  if (tmallMatch) {
    return tmallMatch[1];
  }

  return null;
}

/**
 * 生成移动端淘宝URL
 */
export function buildMobileUrl(taobaoId: string): string {
  return `https://h5.m.taobao.com/awp/core/detail.htm?id=${taobaoId}`;
}

/**
 * 格式化价格显示
 */
export function formatPrice(price: number | string | null | undefined): string {
  if (price === null || price === undefined) return '-';
  const num = typeof price === 'string' ? parseFloat(price) : price;
  return `¥${num.toFixed(2)}`;
}

/**
 * 计算降价幅度
 */
export function calculatePriceDrop(
  oldPrice: number,
  newPrice: number
): { amount: number; percent: number } {
  const amount = oldPrice - newPrice;
  const percent = oldPrice > 0 ? (amount / oldPrice) * 100 : 0;
  return { amount, percent };
}

/**
 * 简单加密（生产环境建议使用更强的加密）
 */
export function encryptCookies(cookies: string): string {
  // 简单的Base64编码，生产环境应使用AES等加密
  return Buffer.from(cookies).toString('base64');
}

export function decryptCookies(encrypted: string): string {
  return Buffer.from(encrypted, 'base64').toString('utf-8');
}
