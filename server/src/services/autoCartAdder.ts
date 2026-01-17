import { Page, BrowserContext, Browser, Frame } from 'playwright';
import { SkuParser, SkuCombination } from './skuParser.js';
import { HumanSimulator, randomDelay, randomRange } from './humanSimulator.js';
import { sharedBrowserManager } from './sharedBrowserManager.js';
import { isPauseRequested, markAddEnd, markAddStart, notifyPausedAtSafePoint, waitUntilResumed } from './accountTaskControl.js';
import fs from 'fs/promises';
import path from 'path';

type SkuSelection = {
  propId: string;
  propName: string;
  valueId: string;
  valueName: string;
};

function normalizeSkuProperties(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  const normalized = raw
    .replace(/[；]/g, ';')
    .replace(/[：]/g, ':')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*/g, ';')
    .trim();

  const pairs: Array<{ label: string; value: string }> = [];
  const pairRe = /([^:;\s]+)\s*:\s*([^;]+?)(?=\s+[^:;\s]+\s*:|;|$)/g;
  for (const match of normalized.matchAll(pairRe)) {
    const label = String(match[1] ?? '').trim();
    const value = String(match[2] ?? '').trim();
    if (!label || !value) continue;
    pairs.push({ label, value });
  }

  if (pairs.length === 0) return normalized;
  pairs.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  return pairs.map((p) => `${p.label}:${p.value}`).join(';');
}

function isDigits(input: unknown): boolean {
  return /^\d+$/.test(String(input ?? '').trim());
}

function toCartSkuIdKey(input: unknown): string | null {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (!isDigits(text)) return null;
  return `id:${text}`;
}

function toCartSkuPropsKey(input: unknown): string | null {
  const norm = normalizeSkuProperties(String(input ?? '').trim());
  if (!norm) return null;
  return `props:${norm}`;
}

function normalizeExistingCartSkuKey(input: unknown): string | null {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (text.startsWith('id:') || text.startsWith('props:')) return text;
  const idKey = toCartSkuIdKey(text);
  if (idKey) return idKey;
  return toCartSkuPropsKey(text);
}

function hasAnySkuKey(set: Set<string>, idKey: string | null, propsKey: string | null): boolean {
  if (idKey && set.has(idKey)) return true;
  if (propsKey && set.has(propsKey)) return true;
  return false;
}

function randomInt(min: number, max: number): number {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

export interface SkuAddResult {
  skuId: string;
  skuProperties: string;
  cartItemId: string | null;
  success: boolean;
  selections?: Array<{ label: string; value: string; vid?: string }>;
  thumbnailUrl?: string | null;
  finalPrice?: number | null;
  originalPrice?: number | null;
  error?: string;
}

export interface AddAllSkusResult {
  taobaoId: string;
  totalSkus: number;
  successCount: number;
  failedCount: number;
  results: SkuAddResult[];
  duration: number;
  skuTotal?: number;
  skuAvailable?: number;
  skuTarget?: number;
  cartProducts?: any[];
  uiTotalCount?: number | null;
}

export interface ProgressCallback {
  (progress: { total: number; current: number; success: number; failed: number }, log?: string): void;
}

export class AutoCartAdder {
  private page!: Page;
  private context!: BrowserContext;
  private browser!: Browser;
  private humanSimulator!: HumanSimulator;
  private skuParser!: SkuParser;
  private exclusiveChain: Promise<void> = Promise.resolve();
  private lastTipEscapeAt = 0;
  private lastTipDeepScanAt = 0;
  private currentAccountId: string | null = null;

  async closeBrowser(): Promise<void> {
    // 不关闭共享浏览器，由 sharedBrowserManager 统一管理
    console.log('[AutoCart] 浏览器会话保持开启用于复用');
  }

  private async ensureBrowser(accountId: string, cookies?: string): Promise<void> {
    // 使用共享浏览器管理器，让 autoCartAdder 和 cartScraper 共享同一个浏览器
    const session = await sharedBrowserManager.getOrCreateSession(accountId, cookies);
    
    this.context = session.context;
    this.page = session.page;
    this.humanSimulator = session.human;
    this.skuParser = new SkuParser(this.page);
    this.currentAccountId = accountId;
    
    console.log('[AutoCart] 使用共享浏览器会话');
  }

  private async navigateToCartPage(): Promise<void> {
    const url = this.page.url();
    if (/cart\.taobao\.com\/cart\.htm/i.test(url)) return;

    await this.humanSimulator.navigateAsHuman('https://cart.taobao.com/cart.htm');
    await this.assertNotAuthPage('打开购物车页');
    await this.humanSimulator.sleep(randomDelay(800, 1600));
    await this.closeFeatureTips().catch(() => {});
    await this.waitForOverlaysCleared().catch(() => {});
  }

  private async collectCartSkuKeysForTaobaoId(
    taobaoId: string
  ): Promise<{ keys: Set<string>; uniqueCount: number }> {
    const targetId = String(taobaoId || '').trim();
    if (!/^\d+$/.test(targetId)) return { keys: new Set<string>(), uniqueCount: 0 };

    await this.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as any })).catch(() => {});
    await this.humanSimulator.sleep(randomDelay(350, 650));

    const keys = new Set<string>();
    const canonical = new Set<string>();
    let stableAfterFound = 0;
    let stableNoNewRounds = 0;
    let stuckRounds = 0;
    let lastTop: number | null = null;
    let seenTarget = false;
    let bottomWaits = 0;
    let endReached = false;
    let endReachedReason: string | null = null;
    let lastLoadedQty = 0;
    let lastScrollHeight = 0;

    let maxRounds = 800;
    let bottomWaitLimit = 4;

    let uiTotalCount: number | null = null;
    const applyUiTotalCount = (raw: unknown) => {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n) || n < 0) return;
      const next = Math.max(0, Math.floor(n));
      if (uiTotalCount !== null && uiTotalCount >= next) return;

      uiTotalCount = next;
      maxRounds = Math.max(maxRounds, 320);
      bottomWaitLimit = Math.max(bottomWaitLimit, 10);
    };

    let uiTotalInitial = await this.page
      .evaluate(() => {
        const header = document.querySelector('.trade-cart-header-container') as HTMLElement | null;
        const headerText = header?.textContent || '';
        const m = /全部商品\s*[（(]\s*(\d{1,6})\s*[）)]/.exec(headerText);
        if (!m) return null;
        const n = parseInt(m[1], 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
      })
      .catch(() => null);
    if (uiTotalInitial === null) {
      uiTotalInitial = await this.page
        .evaluate(() => {
          const header = document.querySelector('.trade-cart-header-container') as HTMLElement | null;
          const headerText = (header?.innerText || header?.textContent || '').trim();
          if (!headerText) return null;

          const re = new RegExp('\u5168\u90e8\u5546\u54c1\\s*[\\(\uff08]\\s*(\\d{1,6})\\s*[\\)\uff09]');
          const m = re.exec(headerText);
          if (!m) return null;

          const n = parseInt(m[1], 10);
          return Number.isFinite(n) && n >= 0 ? n : null;
        })
        .catch(() => null);
    }
    applyUiTotalCount(uiTotalInitial);

    const extract = async (): Promise<{
      rawList: Array<{ skuId: string; skuProperties: string }>;
      found: boolean;
      uiTotalCount: number | null;
      loadedQty: number;
      isEmptyCart: boolean;
      emptyReason: string | null;
      scroll: { top: number; height: number; client: number };
    } | null> => {
      return this.page
        .evaluate((id) => {
          const findScrollContainer = (): HTMLElement => {
            const doc = (document.scrollingElement as HTMLElement) || document.documentElement;
            const firstItem = document.querySelector('.trade-cart-item-info') as HTMLElement | null;
            let el = firstItem?.parentElement as HTMLElement | null;

            const isScrollable = (node: HTMLElement): boolean => {
              if (node.scrollHeight <= node.clientHeight + 32) return false;
              const style = window.getComputedStyle(node);
              const overflowY = style?.overflowY || '';
              return overflowY === 'auto' || overflowY === 'scroll';
            };

            while (el && el !== document.body) {
              if (isScrollable(el)) return el;
              el = el.parentElement;
            }

            return doc;
          };

          const out: Array<{ skuId: string; skuProperties: string }> = [];
          let found = false;
          let loadedQty = 0;

          const cartItems = Array.from(document.querySelectorAll('.trade-cart-item-info'));
          for (const item of cartItems) {
            const qtyEl =
              (item.querySelector('[class*="quantityNumWrapper"]') as HTMLElement | null) ||
              (item.querySelector('.trade-cart-item-quantity [title*="数量"]') as HTMLElement | null) ||
              (item.querySelector('.trade-cart-item-quantity') as HTMLElement | null);
            const qtyRaw = (qtyEl?.getAttribute('title') || qtyEl?.textContent || '').trim();
            const qtyMatch = /(\d{1,6})/.exec(qtyRaw);
            const quantity = Math.max(1, qtyMatch ? parseInt(qtyMatch[1], 10) : 1);
            loadedQty += quantity;

            const titleEl = item.querySelector('a.title--dsuLK9IN') as HTMLAnchorElement | null;
            const linkEl =
              titleEl ||
              (item.querySelector(
                'a[href*=\"item.taobao.com/item.htm\"], a[href*=\"detail.tmall.com/item.htm\"], a[href*=\"/i\"]'
              ) as HTMLAnchorElement | null) ||
              (item.querySelector('a[href*=\"item.htm?id=\"], a[href*=\"?id=\"]') as HTMLAnchorElement | null);

            const hrefRaw = linkEl?.getAttribute('href') || '';
            const href = hrefRaw.startsWith('//') ? 'https:' + hrefRaw : hrefRaw;
            const m = href.match(/[?&]id=(\d+)/) || href.match(/\/i(\d+)\.htm/) || href.match(/item\/(\d+)\.htm/);

            let tid = m ? m[1] : '';
            if (!tid) {
              const root =
                (item.closest?.('[data-id],[data-item-id],[data-itemid],[data-itemId],[data-taobao-id]') as HTMLElement | null) ||
                (item as HTMLElement);
              const dataId =
                root.getAttribute('data-taobao-id') ||
                root.getAttribute('data-item-id') ||
                root.getAttribute('data-itemid') ||
                root.getAttribute('data-id') ||
                '';
              if (/^\d+$/.test(dataId)) tid = dataId;
            }

            if (!tid || String(tid) !== String(id)) continue;

            found = true;

            const skuIdMatch = href.match(/[?&]skuId=(\d+)/i);
            let skuId = skuIdMatch ? skuIdMatch[1] : '';

            if (!skuId) {
              const root =
                (item.closest?.('[data-sku],[data-skuid],[data-sku-id],[data-skuId]') as HTMLElement | null) ||
                (item as HTMLElement);
              const dataSku =
                root.getAttribute('data-skuid') ||
                root.getAttribute('data-sku-id') ||
                root.getAttribute('data-skuId') ||
                root.getAttribute('data-sku') ||
                '';
              if (/^\d+$/.test(dataSku)) skuId = dataSku;
            }

            const skuEl = item.querySelector('.trade-cart-item-sku-old');
            const skuLabels = skuEl ? Array.from(skuEl.querySelectorAll('.label--T4deixnF')) : [];
            const skuProperties = skuLabels
              .map((label) => label.textContent?.trim() || '')
              .join(' ')
              .trim();
            if (skuId || skuProperties) out.push({ skuId, skuProperties });
          }

          let isEmptyCart = false;
          let emptyReason: string | null = null;
          if (cartItems.length === 0) {
            const bodyText = document.body?.innerText || '';
            const directHit =
              [
                '购物车空空如也',
                '购物车竟然是空的',
                '购物车还是空的',
                '你的购物车还是空的',
                '快去挑选宝贝吧',
                '去逛逛',
                '随便逛逛',
              ].find((k) => bodyText.includes(k)) || null;

            const indirectHit = bodyText.includes('购物车') && (bodyText.includes('去逛逛') || bodyText.includes('随便逛逛'));
            isEmptyCart = Boolean(directHit || indirectHit);
            emptyReason = directHit || (indirectHit ? '购物车/去逛逛' : null);
          }

          const header = document.querySelector('.trade-cart-header-container') as HTMLElement | null;
          const headerText = header?.textContent || '';
          const m = /全部商品\s*[（(]\s*(\d{1,6})\s*[）)]/.exec(headerText);
          const uiTotalCountRaw = m ? parseInt(m[1], 10) : NaN;
          let uiTotalCount = Number.isFinite(uiTotalCountRaw) && uiTotalCountRaw >= 0 ? uiTotalCountRaw : null;
          if (uiTotalCount === null) {
            const m2 = new RegExp(
              '\u5168\u90e8\u5546\u54c1\\s*[\\(\uff08]\\s*(\\d{1,6})\\s*[\\)\uff09]'
            ).exec(headerText);
            const n2 = m2 ? parseInt(m2[1], 10) : NaN;
            if (Number.isFinite(n2) && n2 >= 0) uiTotalCount = n2;
          }

          const container = findScrollContainer();
          return {
            rawList: out,
            found,
            uiTotalCount,
            loadedQty,
            isEmptyCart,
            emptyReason,
            scroll: {
              top: container.scrollTop || 0,
              height: container.scrollHeight || 0,
              client: container.clientHeight || window.innerHeight || 0,
            },
          };
        }, targetId)
        .catch(() => null);
    };

    const scrollBy = async (delta: number): Promise<number> => {
      return this.page
        .evaluate((d) => {
          const findScrollContainer = (): HTMLElement => {
            const doc = (document.scrollingElement as HTMLElement) || document.documentElement;
            const firstItem = document.querySelector('.trade-cart-item-info') as HTMLElement | null;
            let el = firstItem?.parentElement as HTMLElement | null;

            const isScrollable = (node: HTMLElement): boolean => {
              if (node.scrollHeight <= node.clientHeight + 32) return false;
              const style = window.getComputedStyle(node);
              const overflowY = style?.overflowY || '';
              return overflowY === 'auto' || overflowY === 'scroll';
            };

            while (el && el !== document.body) {
              if (isScrollable(el)) return el;
              el = el.parentElement;
            }

            return doc;
          };

          const container = findScrollContainer();
          const doc = (document.scrollingElement as HTMLElement) || document.documentElement;
          if (container === doc) {
            window.scrollBy(0, d);
            return doc.scrollTop || (window.scrollY || 0);
          }

          const before = container.scrollTop || 0;
          container.scrollTop = before + d;
          try {
            container.dispatchEvent(new Event('scroll', { bubbles: true }));
          } catch {}
          return container.scrollTop || 0;
        }, delta)
        .catch(() => 0);
    };

    const cappedBottomWaitMs = () => Math.min(8000, 1200 + bottomWaits * 500);

    const detectCartEndMarker = async (): Promise<{ hit: boolean; reason: string | null }> => {
      return this.page
        .evaluate(() => {
          const keywords = ['猜你喜欢', '为你推荐', '你可能还喜欢'];
          const endKeywords = ['没有更多', '已经到底', '到底了'];

          const bodyText = document.body?.innerText || '';
          const hitKeyword = keywords.find((k) => bodyText.includes(k)) || null;

          const infiniteText =
            (document.querySelector('.trade-infinite-container') as HTMLElement | null)?.innerText?.trim() || '';
          const hitEnd = endKeywords.find((k) => infiniteText.includes(k)) || null;

          const fallbackReason =
            hitKeyword ||
            hitEnd ||
            ['\u731c\u4f60\u559c\u6b22', '\u4e3a\u4f60\u63a8\u8350', '\u4f60\u53ef\u80fd\u8fd8\u559c\u6b22'].find((k) =>
              bodyText.includes(k)
            ) ||
            ['\u6ca1\u6709\u66f4\u591a', '\u5df2\u7ecf\u5230\u5e95', '\u5df2\u7ecf\u5230\u5e95\u4e86', '\u5230\u5e95\u4e86', '\u5230\u5934\u4e86'].find(
              (k) => infiniteText.includes(k)
            ) ||
            null;

          return { hit: Boolean(fallbackReason), reason: fallbackReason };
        })
        .catch(() => ({ hit: false, reason: null }));
    };

    for (let round = 0; ; round++) {
      if (round >= maxRounds) {
        if (uiTotalCount !== null && lastLoadedQty < uiTotalCount) {
          console.warn(
            `[AutoCart] 购物车预检查达到最大轮次 loadedQty=${lastLoadedQty} < uiTotalCount=${uiTotalCount}；停止滚动`
          );
        }
        break;
      }

      const snapshot = await extract();
      if (!snapshot) break;

      applyUiTotalCount(snapshot.uiTotalCount);
      const loadedQty = Math.max(0, Math.floor(Number(snapshot.loadedQty) || 0));
      const scrollHeight = Math.max(0, Math.floor(Number(snapshot.scroll.height) || 0));
      if (snapshot.isEmptyCart) {
        applyUiTotalCount(0);
        console.log(`[AutoCart] 购物车看起来为空（${snapshot.emptyReason || 'unknown'}）`);
        break;
      }
      if (loadedQty > lastLoadedQty || scrollHeight > lastScrollHeight) {
        bottomWaits = 0;
        lastLoadedQty = loadedQty;
        lastScrollHeight = scrollHeight;
      }

      const needsFullLoad = uiTotalCount !== null && loadedQty < uiTotalCount && !endReached;
      const fullyLoaded = uiTotalCount === null || loadedQty >= uiTotalCount || endReached;

      let added = 0;
      for (const item of snapshot.rawList) {
        const idKey = toCartSkuIdKey(item?.skuId);
        const propsKey = toCartSkuPropsKey(item?.skuProperties);
        const canonKey = idKey || propsKey;
        if (!canonKey) continue;

        if (!canonical.has(canonKey)) {
          canonical.add(canonKey);
          added++;
        }
        if (idKey) keys.add(idKey);
        if (propsKey) keys.add(propsKey);
      }

      if (snapshot.found) seenTarget = true;

      stableNoNewRounds = added === 0 ? stableNoNewRounds + 1 : 0;
      if (seenTarget) {
        stableAfterFound = added === 0 ? stableAfterFound + 1 : 0;
        if (stableAfterFound >= 2 && fullyLoaded) break;
      } else if (fullyLoaded && uiTotalCount !== null) {
        break;
      }

      const { top, client } = snapshot.scroll;
      const atBottom = scrollHeight > 0 && client > 0 && top + client >= scrollHeight - 2;
      if (atBottom && stableNoNewRounds >= 2) {
        if (needsFullLoad) {
          if (bottomWaits >= bottomWaitLimit) {
            const end = await detectCartEndMarker();
            if (end.hit) {
              endReached = true;
              endReachedReason = end.reason;
              console.warn(
                `[AutoCart] 购物车预检查到达底部标记（${end.reason || 'unknown'}）loadedQty=${loadedQty} < uiTotalCount=${uiTotalCount}；停止滚动`
              );
              break;
            }
          }

          bottomWaits++;
          stableNoNewRounds = 0;
          await this.page.waitForTimeout(cappedBottomWaitMs()).catch(() => {});
          await scrollBy(-Math.max(260, Math.floor(client * 0.25)));
          await this.page.waitForTimeout(randomDelay(240, 420)).catch(() => {});
          continue;
        }
        if (!seenTarget) break;
        if (bottomWaits < bottomWaitLimit) {
          bottomWaits++;
          stableNoNewRounds = 0;
          await this.page.waitForTimeout(cappedBottomWaitMs()).catch(() => {});
          await scrollBy(-Math.max(260, Math.floor(client * 0.25)));
          await this.page.waitForTimeout(randomDelay(240, 420)).catch(() => {});
          continue;
        }
        break;
      }

      const step = Math.max(650, Math.min(2400, Math.floor((client || 800) * 0.95)));
      const nextTop = await scrollBy(step);

      if (lastTop !== null && nextTop === lastTop) stuckRounds++;
      else stuckRounds = 0;
      lastTop = nextTop;

      if (stuckRounds >= 2 && stableNoNewRounds >= 1) {
        if (needsFullLoad) {
          if (bottomWaits >= bottomWaitLimit) {
            const end = await detectCartEndMarker();
            if (end.hit) {
              endReached = true;
              endReachedReason = end.reason;
              console.warn(
                `[AutoCart] 购物车预检查到达底部标记（${end.reason || 'unknown'}）loadedQty=${loadedQty} < uiTotalCount=${uiTotalCount}；停止滚动`
              );
              break;
            }
          }

          bottomWaits++;
          stableNoNewRounds = 0;
          await this.page.waitForTimeout(cappedBottomWaitMs()).catch(() => {});
          await scrollBy(-Math.max(260, Math.floor(step * 0.25)));
          await this.page.waitForTimeout(randomDelay(240, 420)).catch(() => {});
          continue;
        }
        if (seenTarget && bottomWaits < bottomWaitLimit) {
          bottomWaits++;
          stableNoNewRounds = 0;
          await this.page.waitForTimeout(cappedBottomWaitMs()).catch(() => {});
          await scrollBy(-Math.max(260, Math.floor(step * 0.25)));
          await this.page.waitForTimeout(randomDelay(240, 420)).catch(() => {});
          continue;
        }
        break;
      }

      await this.humanSimulator.sleep(randomDelay(380, 780));
      await this.closeFeatureTips().catch(() => {});
      await this.waitForOverlaysCleared().catch(() => {});
    }

    if (endReached && endReachedReason) {
      console.log(`[AutoCart] 购物车预检查检测到结束标记: ${endReachedReason}`);
    }

    return { keys, uniqueCount: canonical.size };
  }

  private async openProductFromCartOrNavigate(
    taobaoId: string
  ): Promise<{ cartUrl: string; usedPopup: boolean; usedSameTab: boolean; cartPage: Page }> {
    const cartPage = this.page;
    const cartUrl = cartPage.url();

    // 在新标签页打开商品详情页，保持购物车页面不关闭
    const url = `https://item.taobao.com/item.htm?id=${taobaoId}`;
    console.log(`[AutoCart] 新标签页打开商品页: ${url}`);
    
    const productPage = await this.context.newPage();
    this.page = productPage;
    this.humanSimulator = new HumanSimulator(this.page);
    this.skuParser = new SkuParser(this.page);
    
    await this.humanSimulator.navigateAsHuman(url);
    
    // 返回购物车页面引用，用于后续刷新获取价格
    return { cartUrl, usedPopup: true, usedSameTab: false, cartPage };
  }

  private async returnToCartAfterAdd(cartUrl: string, cartPage: Page): Promise<void> {
    try {
      // 优先按“后退键”（更像人）
      await this.page.keyboard.press('Alt+Left').catch(() => {});
      await this.page.waitForTimeout(randomDelay(300, 650));
      if (/cart\.taobao\.com\/cart\.htm/i.test(this.page.url())) return;

      await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
      await this.page.waitForTimeout(randomDelay(300, 650));
      if (/cart\.taobao\.com\/cart\.htm/i.test(this.page.url())) return;

      await this.page.goto(cartUrl || 'https://cart.taobao.com/cart.htm', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      }).catch(() => {});
    } finally {
      await this.closeFeatureTips().catch(() => {});
      await this.waitForOverlaysCleared().catch(() => {});

      // 如果当前页面不是最初的购物车 tab，则切回去（避免用户看到奇怪页面）
      if (this.page !== cartPage) {
        this.page = cartPage;
        this.humanSimulator = new HumanSimulator(this.page);
        this.skuParser = new SkuParser(this.page);
      }
    }
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveChain;
    let release!: () => void;
    this.exclusiveChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private isAuthOrChallengeUrl(url: string): boolean {
    return /login\.taobao\.com|login\.tmall\.com|passport\.taobao\.com|sec\.taobao\.com|captcha|verify|risk/i.test(url);
  }

  private async tryQuickLogin(stage: string): Promise<boolean> {
    const beforeUrl = this.page.url();
    if (!/login\.taobao\.com|login\.tmall\.com|passport\.taobao\.com/i.test(beforeUrl)) return false;
    if (/captcha|verify|risk|sec\.taobao\.com/i.test(beforeUrl)) return false;

    const isHavanaOneClick = /\/havanaone\/login\/login\.htm/i.test(beforeUrl);
    console.log(`[AutoCart] 检测到登录页，尝试快速登录 stage=${stage} url=${beforeUrl}`);

    const frames = this.page.frames();
    const primaryKeywords = ['快速登录', '一键登录', '快捷登录', '免密登录'];
    const fallbackKeywords = isHavanaOneClick ? ['确认登录', '立即登录', '登录'] : ['确认登录', '立即登录'];
    const blacklistKeywords = ['扫码', '密码', '短信', '注册', '切换'];
    const keywords = [...primaryKeywords, ...fallbackKeywords];

    let clicked = false;
    for (const frame of frames) {
      const ok = await this.clickKeywordButtonInFrame(frame, keywords, blacklistKeywords).catch(() => false);
      if (ok) {
        clicked = true;
        break;
      }
    }

    if (!clicked) return false;

    const timeoutMs = 20000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const url = this.page.url();
      if (!this.isAuthOrChallengeUrl(url)) {
        console.log(`[AutoCart] 快速登录成功 stage=${stage} url=${url}`);
        return true;
      }
      await this.page.waitForTimeout(500).catch(() => {});
    }

    return !this.isAuthOrChallengeUrl(this.page.url());
  }

  private async clickKeywordButtonInFrame(
    frame: Frame,
    keywords: string[],
    blacklistKeywords: string[]
  ): Promise<boolean> {
    return frame
      .evaluate(
        ({ keywords, blacklistKeywords }) => {
          const visible = (el: Element): boolean => {
            const node = el as HTMLElement;
            const style = window.getComputedStyle(node);
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = node.getBoundingClientRect();
            if (rect.width < 16 || rect.height < 10) return false;
            return true;
          };

          const textOf = (el: Element): string => {
            const node = el as any;
            return String(node?.innerText || node?.textContent || node?.value || '').trim();
          };

          const isBlacklisted = (text: string): boolean =>
            blacklistKeywords.some((k) => k && text.includes(k));

          const candidates = Array.from(
            document.querySelectorAll('button, a, [role=\"button\"], input[type=\"button\"], input[type=\"submit\"]')
          );

          for (const key of keywords) {
            if (!key) continue;
            for (const el of candidates) {
              if (!visible(el)) continue;
              const text = textOf(el);
              if (!text || isBlacklisted(text)) continue;
              if (!text.includes(key)) continue;
              try {
                (el as HTMLElement).click();
                return true;
              } catch {}
            }
          }

          return false;
        },
        { keywords, blacklistKeywords }
      )
      .catch(() => false);
  }

  private async assertNotAuthPage(stage: string): Promise<void> {
    const url = this.page.url();
    if (this.isAuthOrChallengeUrl(url)) {
      const bypassed = await this.tryQuickLogin(stage).catch(() => false);
      if (bypassed) return;
      throw new Error(`需要登录/验证码（${stage}）：${url}`);
    }

    const title = await this.page.title().catch(() => '');
    if (/登录|Login|安全验证|验证码/.test(title) && /taobao|tmall|alibaba/i.test(url)) {
      const bypassed = await this.tryQuickLogin(stage).catch(() => false);
      if (bypassed) return;
      throw new Error(`需要登录/验证码（${stage}）：${url}`);
    }

    const bodyText = await this.page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    if (/(扫码登录|密码登录|短信登录|安全验证|验证码|滑块|请先登录)/.test(bodyText)) {
      const bypassed = await this.tryQuickLogin(stage).catch(() => false);
      if (bypassed) return;
      throw new Error(`需要登录/验证码（${stage}）：${url}`);
    }
  }

  private async maybeSaveDebugArtifacts(tag: string, meta: Record<string, unknown>): Promise<void> {
    if (process.env.AUTO_CART_DEBUG !== '1') return;

    try {
      const dir = path.join(process.cwd(), 'data', '_debug', 'auto-cart');
      await fs.mkdir(dir, { recursive: true });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeTag = tag.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const prefix = `${stamp}_${safeTag}`;

      const screenshotPath = path.join(dir, `${prefix}.png`);
      const metaPath = path.join(dir, `${prefix}.json`);

      await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      await fs.writeFile(
        metaPath,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            url: this.page.url(),
            ...meta,
          },
          null,
          2
        ),
        'utf8'
      );
    } catch {
      // ignore debug artifact errors
    }
  }

  private async waitForOverlaysCleared(timeoutMs = 3000): Promise<void> {
    // 使用大小写不敏感的选择器，覆盖 Mask/mask/MASK 等变体
    await this.page
      .waitForSelector('.CommonMask--UmpuIa8a, [class*="mask" i], [class*="overlay" i], [class*="Mask"], [class*="Modal"], [class*="modal" i]', {
        state: 'hidden',
        timeout: timeoutMs,
      })
      .catch(() => {});
  }

  private async clickLocatorAsHuman(locator: any): Promise<void> {
    const base = await locator.first().elementHandle().catch(() => null);
    if (!base) {
      await locator.first().click({ timeout: 1500 }).catch(() => {});
      return;
    }

    const target = await base
      .evaluateHandle((el: any) => el?.closest?.('button,a,[role="button"]') || el)
      .then((h: any) => h?.asElement?.() ?? null)
      .catch(() => null);

    const handle = target || base;
    const box = await handle.boundingBox().catch(() => null);
    if (!box) {
      await locator.first().click({ timeout: 1500 }).catch(() => {});
      return;
    }

    const jitterX = Math.min(12, Math.max(3, Math.floor(box.width * 0.12)));
    const jitterY = Math.min(10, Math.max(3, Math.floor(box.height * 0.12)));
    const x = box.x + box.width / 2 + randomInt(-jitterX, jitterX);
    const y = box.y + box.height / 2 + randomInt(-jitterY, jitterY);

    await this.page.mouse.move(x, y, { steps: randomInt(12, 28) }).catch(() => {});
    await this.humanSimulator.sleep(randomDelay(80, 180));
    await this.page.mouse.down().catch(() => {});
    await this.humanSimulator.sleep(randomDelay(40, 110));
    await this.page.mouse.up().catch(() => {});
  }

  async addAllSkusToCart(
    accountId: string,
    taobaoId: string,
    cookies?: string,
    options?: {
      headless?: boolean;
      onProgress?: ProgressCallback;
      existingCartSkus?: Map<string, Set<string>>;
      skuDelayMs?: { min: number; max: number };
      skuLimit?: number;
      refreshCartAfterAdd?: boolean;
    }
  ): Promise<AddAllSkusResult> {
    return this.runExclusive(async () => {
      markAddStart(accountId);
      const startTime = Date.now();
      console.log(`[AutoCart] 开始 taobaoId=${taobaoId} accountId=${accountId}`);
      console.log(`[AutoCart] 模式: ${options?.headless === false ? '可视' : '无头'}`);

      let lastProgress: { total: number; current: number; success: number; failed: number } = {
        total: 0,
        current: 0,
        success: 0,
        failed: 0,
      };

      const pauseIfRequested = async (logOnce?: string): Promise<void> => {
        if (!isPauseRequested(accountId)) return;

        notifyPausedAtSafePoint(accountId);

        const send = (log?: string) => {
          if (!options?.onProgress) return;
          try {
            options.onProgress(lastProgress, log);
          } catch {}
        };

        if (logOnce) send(logOnce);

        const resumed = waitUntilResumed(accountId);
        while (isPauseRequested(accountId)) {
          const done = await Promise.race([
            resumed.then(() => true),
            this.humanSimulator.sleep(2500).then(() => false),
          ]);
          if (done) break;
          send();
        }
      };

      const sleepInterruptible = async (ms: number): Promise<void> => {
        let remaining = Math.max(0, Math.floor(ms));
        while (remaining > 0) {
          if (isPauseRequested(accountId)) break;
          const step = Math.min(500, remaining);
          await this.humanSimulator.sleep(step);
          remaining -= step;
        }
      };

      try {
        // 复用或创建浏览器实例
        await this.ensureBrowser(accountId, cookies);

        // 阶段1：打开购物车预检查已存在的SKU
        // 如果批量模式已经预先抓取过购物车，则直接使用传入的数据
        let existedSkuKeys: Set<string>;
        let existedSkuCount = 0;
        if (options?.existingCartSkus?.has(taobaoId)) {
          const raw = options.existingCartSkus.get(taobaoId)!;
          existedSkuKeys = new Set<string>();
          for (const entry of raw) {
            const key = normalizeExistingCartSkuKey(entry);
            if (key) existedSkuKeys.add(key);
          }
          const idCount = Array.from(existedSkuKeys).filter((k) => k.startsWith('id:')).length;
          existedSkuCount = idCount > 0 ? idCount : existedSkuKeys.size;
          console.log(`[AutoCart] 使用预取购物车数据: taobaoId=${taobaoId} existedSkus=${existedSkuCount}`);
          if (options?.onProgress) {
            options.onProgress(
              { total: 0, current: 0, success: 0, failed: 0 },
              `【阶段1/5】使用预抓取的购物车数据，已存在 ${existedSkuCount} 个SKU`
            );
          }
          lastProgress = { total: 0, current: 0, success: 0, failed: 0 };
          // 直接跳到商品页，不需要先打开购物车
        } else {
          if (options?.onProgress) {
            options.onProgress(
              { total: 0, current: 0, success: 0, failed: 0 },
              '【阶段1/5】打开购物车，预检查已存在的SKU...'
            );
          }
          lastProgress = { total: 0, current: 0, success: 0, failed: 0 };
          await this.navigateToCartPage();
          const precheck = await this.collectCartSkuKeysForTaobaoId(taobaoId);
          existedSkuKeys = precheck.keys;
          existedSkuCount = precheck.uniqueCount;
          console.log(`[AutoCart] 购物车预检查: taobaoId=${taobaoId} existedSkus=${existedSkuCount}`);
          if (options?.onProgress) {
            options.onProgress(
              { total: 0, current: 0, success: 0, failed: 0 },
              `【阶段1/5】购物车预检查完成，已存在 ${existedSkuCount} 个SKU`
            );
          }
          lastProgress = { total: 0, current: 0, success: 0, failed: 0 };
        }

        // 阶段2：打开商品详情页
        if (options?.onProgress) {
          options.onProgress(
            { total: 0, current: 0, success: 0, failed: 0 },
            '【阶段2/5】打开商品详情页...'
          );
        }
        lastProgress = { total: 0, current: 0, success: 0, failed: 0 };
        const openInfo = await this.openProductFromCartOrNavigate(taobaoId);
        await this.assertNotAuthPage('打开商品页');

        await this.humanSimulator.browsePage({
          scrollDown: true,
          viewImages: true,
          // 首次进入页面做一次“浏览”，但避免拖慢整体加购节奏
          duration: randomDelay(1200, 2600),
        });

        // 关闭可能出现的新功能提示弹窗（会遮挡SKU按钮）
        await this.closeFeatureTips();
        await this.waitForOverlaysCleared();

        // 阶段3：解析SKU树
        if (options?.onProgress) {
          options.onProgress(
            { total: 0, current: 0, success: 0, failed: 0 },
            '【阶段3/5】解析商品SKU树...'
          );
        }
        lastProgress = { total: 0, current: 0, success: 0, failed: 0 };
        const skuTree = await this.skuParser.parseSkuTree(taobaoId);
        console.log(`[AutoCart] 找到 ${skuTree.combinations.length} 个 SKU 组合`);

        const availableSkus = skuTree.combinations.filter((sku) => sku.stock > 0);
        console.log(`[AutoCart] 可用 SKU 数量: ${availableSkus.length}`);

        const rawLimit = (options as any)?.skuLimit;
        const skuLimit = Number.isFinite(Number(rawLimit)) ? Math.max(0, Math.floor(Number(rawLimit))) : 0;
        const skuTotal = skuTree.combinations.length;
        const skuAvailable = availableSkus.length;
        const skuTarget = skuLimit > 0 ? Math.min(skuLimit, skuAvailable) : skuAvailable;

        const existedKeys = existedSkuKeys;

        const shuffled = this.shuffleArray(availableSkus);
        let selected: SkuCombination[] = shuffled;
        let existingSelected: SkuCombination[] = [];

        if (skuLimit > 0) {
          for (const sku of shuffled) {
            if (existingSelected.length >= skuTarget) break;
            const idKey = toCartSkuIdKey(sku.skuId);
            const propsKey = toCartSkuPropsKey(sku.properties);
            if (hasAnySkuKey(existedKeys, idKey, propsKey)) existingSelected.push(sku);
          }

          const candidates = shuffled.filter((sku) => {
            const idKey = toCartSkuIdKey(sku.skuId);
            const propsKey = toCartSkuPropsKey(sku.properties);
            return !hasAnySkuKey(existedKeys, idKey, propsKey);
          });

          selected = [...existingSelected, ...candidates];
        }

        const skippedCount =
          skuLimit > 0
            ? existingSelected.length
            : selected.filter((sku) => {
                const idKey = toCartSkuIdKey(sku.skuId);
                const propsKey = toCartSkuPropsKey(sku.properties);
                return hasAnySkuKey(existedKeys, idKey, propsKey);
              }).length;
        const toAddCount = skuLimit > 0 ? Math.max(0, skuTarget - skippedCount) : selected.length - skippedCount;

        // 阶段4：开始加购
        if (options?.onProgress) {
          options.onProgress(
            { total: skuTarget, current: 0, success: 0, failed: 0 },
            `【阶段4/5】开始加购：目标 ${skuTarget} 个SKU（可用 ${skuAvailable}），已存在 ${skippedCount} 个将跳过，需新加购 ${toAddCount} 个`
          );
        }
        lastProgress = { total: skuTarget, current: 0, success: 0, failed: 0 };

        const results: SkuAddResult[] = [];
        const skuDelayMinMsRaw = (options as any)?.skuDelayMs?.min;
        const skuDelayMaxMsRaw = (options as any)?.skuDelayMs?.max;
        const skuDelayMinMs = Number.isFinite(Number(skuDelayMinMsRaw))
          ? Math.max(0, Math.floor(Number(skuDelayMinMsRaw)))
          : 900;
        const skuDelayMaxMs = Number.isFinite(Number(skuDelayMaxMsRaw))
          ? Math.max(skuDelayMinMs, Math.floor(Number(skuDelayMaxMsRaw)))
          : 2200;

        let successCount = 0;
        let failedCount = 0;

        for (let i = 0; i < selected.length; i++) {
          await pauseIfRequested('【抢占】暂停加购，优先抓价中…');

          if (skuLimit > 0 && successCount >= skuTarget) break;

          const sku = selected[i];
          const displayTotal = skuLimit > 0 ? skuTarget : selected.length;
          const displayIndex = skuLimit > 0 ? Math.min(successCount + 1, skuTarget) : i + 1;
          console.log(`[AutoCart] 处理 SKU ${displayIndex}/${displayTotal}: ${sku.properties}`);

          try {
            const idKey = toCartSkuIdKey(sku.skuId);
            const propsKey = toCartSkuPropsKey(sku.properties);
            let result: SkuAddResult;
            const skipped = hasAnySkuKey(existedKeys, idKey, propsKey);

            if (skipped) {
              console.log(`[AutoCart] SKU 已在购物车中，跳过: ${sku.properties}`);
              result = {
                skuId: sku.skuId,
                skuProperties: sku.properties,
                cartItemId: null,
                success: true,
                selections: sku.selections.map((s: any) => ({
                  label: s.propName,
                  value: s.valueName,
                  vid: s.valueId,
                })),
                thumbnailUrl: (sku as any)?.imageUrl ?? null,
              };
              successCount++;
              if (idKey) existedKeys.add(idKey);
              if (propsKey) existedKeys.add(propsKey);
            } else {
              result = await this.addSingleSkuAsHuman(sku, taobaoId);
              if (result.success) {
                successCount++;
                if (idKey) existedKeys.add(idKey);
                if (propsKey) existedKeys.add(propsKey);
              } else {
                failedCount++;
              }
            }

            results.push(result);

            // 实时更新进度
            const current = skuLimit > 0 ? Math.min(successCount, skuTarget) : i + 1;
            lastProgress = { total: skuTarget, current, success: successCount, failed: failedCount };
            if (options?.onProgress) {
              const log =
                skuLimit > 0
                  ? `补齐 ${successCount}/${skuTarget}：${result.success ? '成功' : '失败'} - ${sku.properties}`
                  : `已处理 ${i + 1}/${selected.length}：${result.success ? '成功' : '失败'} - ${sku.properties}`;
              options.onProgress(
                { total: skuTarget, current, success: successCount, failed: failedCount },
                log
              );
            }

            if (skuLimit > 0 && successCount >= skuTarget) break;

            if (!skipped && i < selected.length - 1) {
              // SKU 间隔：保持随机但适度加快；偶尔更长停顿更“像人”
              let delay = randomDelay(skuDelayMinMs, skuDelayMaxMs);
              if (Math.random() < 0.08) delay += randomDelay(2000, 5000);
              console.log(`[AutoCart] 等待 ${delay}ms 后继续下一个 SKU...`);
              await sleepInterruptible(delay);
              await pauseIfRequested('【抢占】暂停加购，优先抓价中…');
            }
          } catch (error: any) {
            console.error(`[AutoCart] SKU 失败: ${sku.skuId}`, error);
            await this.maybeSaveDebugArtifacts('sku_failed', {
              taobaoId,
              skuId: sku.skuId,
              skuProperties: sku.properties,
              error: error?.message ?? String(error),
            });

            results.push({
              skuId: sku.skuId,
              skuProperties: sku.properties,
              cartItemId: null,
              success: false,
              error: error.message,
            });

            // 更新失败进度
            failedCount++;
            const current = skuLimit > 0 ? Math.min(successCount, skuTarget) : i + 1;
            lastProgress = { total: skuTarget, current, success: successCount, failed: failedCount };
            if (options?.onProgress) {
              const log =
                skuLimit > 0
                  ? `补齐 ${successCount}/${skuTarget}：失败 - ${error.message}`
                  : `已处理 ${i + 1}/${selected.length}：失败 - ${error.message}`;
              options.onProgress(
                { total: skuTarget, current, success: successCount, failed: failedCount },
                log
              );
            }
          }
        }

        const duration = Date.now() - startTime;

        console.log(`[AutoCart] 完成: ${successCount}/${skuTarget} 成功，耗时=${duration}ms`);

        // 阶段5：关闭商品详情页，切回购物车页面刷新获取价格
        const refreshCartAfterAdd = options?.refreshCartAfterAdd !== false;
        if (options?.onProgress) {
          options.onProgress(
            { total: skuTarget, current: skuTarget, success: successCount, failed: failedCount },
            refreshCartAfterAdd
              ? '【阶段5/5】返回购物车页面刷新获取价格...'
              : '【阶段5/5】已完成加购，批量任务将最后统一刷新购物车获取价格...'
          );
        }
        lastProgress = {
          total: skuTarget,
          current: skuTarget,
          success: successCount,
          failed: failedCount,
        };
        
        // 关闭商品详情页（当前页面）
        await this.page.close().catch(() => {});
        
        // 切回购物车页面
        this.page = openInfo.cartPage;
        this.humanSimulator = new HumanSimulator(this.page);
        this.skuParser = new SkuParser(this.page);

        if (!refreshCartAfterAdd) {
          return {
            taobaoId,
            totalSkus: skuTarget,
            successCount,
            failedCount,
            results,
            duration,
            skuTotal,
            skuAvailable,
            skuTarget,
          };
        }
        
        // 刷新购物车页面获取最新价格
        console.log('[AutoCart] 刷新购物车页以获取最新价格...');
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await this.humanSimulator.sleep(randomDelay(1000, 2000));
        await this.closeFeatureTips().catch(() => {});
        await this.waitForOverlaysCleared().catch(() => {});

        const uiTotalCount = await this.page
          .evaluate(() => {
            const header = document.querySelector('.trade-cart-header-container') as HTMLElement | null;
            const text = (header?.innerText || header?.textContent || '').trim();
            if (!text) return null;

            const re = new RegExp('\u5168\u90e8\u5546\u54c1\\s*[\\(\uff08]\\s*(\\d{1,6})\\s*[\\)\uff09]');
            const m = re.exec(text);
            if (!m) return null;

            const n = parseInt(m[1], 10);
            return Number.isFinite(n) && n >= 0 ? n : null;
          })
          .catch(() => null);

        // 直接在当前页面抓取购物车数据
        console.log('[AutoCart] 从当前页面提取购物车数据...');
        const cartProducts = await this.extractCartDataFromCurrentPage(taobaoId);
        console.log(`[AutoCart] 已提取 ${cartProducts.length} 个商品 taobaoId=${taobaoId}`);

        return {
          taobaoId,
          totalSkus: skuTarget,
          successCount,
          failedCount,
          results,
          duration,
          cartProducts, // 直接返回购物车数据，避免再次调用 scrapeCart
          uiTotalCount,
          skuTotal,
          skuAvailable,
          skuTarget,
        };
      } finally {
        markAddEnd(accountId);
        // 不关闭页面和 context，保持购物车页面打开供用户查看
        // 注意：浏览器实例会一直运行，直到用户手动关闭或下次任务复用
        console.log('[AutoCart] 任务完成，保持购物车页打开供用户查看');
      }
    });
  }

  private async addSingleSkuAsHuman(
    sku: SkuCombination,
    taobaoId: string
  ): Promise<SkuAddResult> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.addSingleSkuAttempt(sku, taobaoId, attempt);
      } catch (error: any) {
        console.warn(
          `[AutoCart] 单 SKU 加购尝试 ${attempt} 失败 skuId=${sku.skuId}: ${error?.message ?? String(error)}`
        );

        await this.maybeSaveDebugArtifacts('add_single_attempt_failed', {
          taobaoId,
          skuId: sku.skuId,
          skuProperties: sku.properties,
          attempt,
          error: error?.message ?? String(error),
        });

        if (attempt === 1) {
          await this.resetToProductPage(taobaoId);
          continue;
        }
        throw error;
      }
    }

    throw new Error('加购失败：未知错误');
  }

  private async resetToProductPage(taobaoId: string): Promise<void> {
    const url = `https://item.taobao.com/item.htm?id=${taobaoId}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await this.closeFeatureTips().catch(() => {});
    await this.closeAddCartModal().catch(() => {});
    await this.waitForOverlaysCleared().catch(() => {});
  }

  private async addSingleSkuAttempt(sku: SkuCombination, taobaoId: string, attempt: number): Promise<SkuAddResult> {
    console.log(`[AutoCart] 正在加购 SKU（第 ${attempt} 次尝试）: ${sku.properties}`);

    await this.assertNotAuthPage('开始加购');

    try {
      await this.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await this.humanSimulator.sleep(randomDelay(250, 600));
    } catch (e) {
      console.warn('[AutoCart] 滚动到顶部失败:', e);
    }

    await this.closeAddCartModal();
    await this.closeFeatureTips();
    await this.waitForOverlaysCleared();

    for (let i = 0; i < sku.selections.length; i++) {
      const selection = sku.selections[i] as SkuSelection;
      console.log(
        `[AutoCart] 选择规格层 ${i + 1}/${sku.selections.length}: propId=${selection.propId}, valueId=${selection.valueId}`
      );

      await this.selectSkuPropertyAsHuman(selection);
      console.log(`[AutoCart] 第 ${i + 1} 层选择成功`);

      await this.humanSimulator.sleep(randomDelay(250, 600));
      if (i < sku.selections.length - 1) {
        await this.waitForPriceStable();
      }
    }

    if (Math.random() < 0.15) {
      console.log('[AutoCart] 随机滚动...');
      await this.humanSimulator.randomScroll({ distance: randomRange(200, 500) });
    }

    console.log('[AutoCart] 偶发游走检查...');
    await this.humanSimulator.occasionalWander();
    console.log('[AutoCart] 查找加购按钮...');

    const addCartBtnSelectors = [
      // 优先：基于购物车图标/文本的选择器（避免 first-child 误点“立即购买”）
      '[class*="btnItem"]:has([class*="icon-taobaojiarugouwuche"])',
      'button:has-text("加入购物车")',
      'a:has-text("加入购物车")',
      '.addcart-btn',
      '.add-cart-btn',
      'button[class*="AddCart"]',
      // 兜底：天猫面板第一个按钮（部分页面为加购）
      '#tbpcDetail_SkuPanelFoot .btnItem--NstK3Os1:first-child',
    ];

    let addCartBtn: ReturnType<Page['locator']> | null = null;
    for (const selector of addCartBtnSelectors) {
      const candidate = this.page.locator(selector).first();
      const visible = await candidate.isVisible().catch(() => false);
      if (visible) {
        addCartBtn = candidate;
        console.log(`[AutoCart] 找到加购按钮 selector=${selector}`);
        break;
      }
    }

    if (!addCartBtn) {
      throw new Error('加购按钮未找到');
    }

    await addCartBtn.scrollIntoViewIfNeeded().catch(() => {});
    await this.humanSimulator.sleep(randomDelay(200, 500));

    // 这里经常会冒出“新增功能/大图模式”等引导遮罩，先按“知道了”等关闭再点加购
    await this.closeFeatureTips();
    await this.waitForOverlaysCleared();

    const btnDisabled = await addCartBtn
      .evaluate((el: any) => Boolean(el?.disabled) || el?.getAttribute?.('aria-disabled') === 'true')
      .catch(() => false);
    if (btnDisabled) {
      throw new Error('加购按钮不可用（可能未选全规格/库存不足/被弹窗遮挡）');
    }

    const missingDims = await this.getMissingSkuDimensions();
    if (missingDims.length > 0) {
      throw new Error(`SKU未选全：${missingDims.join('、')}`);
    }

    const beforeCount = await this.getMiniCartCount();

    await this.clickLocatorAsHuman(addCartBtn);

    await this.assertNotAuthPage('点击加购后');

    const success = await this.waitForAddCartSuccess(beforeCount);
    if (!success) {
      const reason = await this.getAddCartFailureReason();
      throw new Error(reason ? `加购失败：${reason}` : '加购失败：未检测到成功反馈');
    }

    await this.closeAddCartModal();
    await this.waitForOverlaysCleared();

    await this.assertNotAuthPage('加购完成后');

    const cartItemId = await this.extractCartItemIdFromRequest().catch(() => null);

    console.log(`[AutoCart] SKU 加购成功: ${sku.skuId}`);

    return {
      skuId: sku.skuId,
      skuProperties: sku.properties,
      cartItemId,
      success: true,
      selections: sku.selections.map((s: any) => ({
        label: s.propName,
        value: s.valueName,
        vid: s.valueId,
      })),
      thumbnailUrl: (sku as any)?.imageUrl ?? null,
    };
  }

  private async selectSkuPropertyAsHuman(selection: SkuSelection): Promise<void> {
    await this.closeFeatureTips();
    await this.waitForOverlaysCleared();

    const selectors = [
      `[data-vid="${selection.valueId}"][class*="valueItem"]`,
      `[data-vid="${selection.valueId}"]`,
      `[data-value="${selection.valueId}"]`,
      `[data-id="${selection.valueId}"]`,
      `[data-sku-value="${selection.valueId}"]`,
    ];

    const skuPanel = this.page.locator('[id*="SkuPanel"]').first();

    let element: ReturnType<Page['locator']> | null = null;
    for (const selector of selectors) {
      const candidate = skuPanel.locator(selector).first();
      const visible = await candidate.isVisible().catch(() => false);
      if (visible) {
        element = candidate;
        break;
      }
    }

    if (!element) {
      const byText = skuPanel.getByText(selection.valueName, { exact: true }).first();
      const visible = await byText.isVisible().catch(() => false);
      if (visible) {
        element = byText;
      }
    }

    if (!element) {
      throw new Error(`SKU选项未找到：${selection.propName}=${selection.valueName}`);
    }

    const disabled = await element
      .evaluate((el: any) => {
        const attr = (name: string) => el?.getAttribute?.(name);
        return attr('data-disabled') === 'true' || attr('aria-disabled') === 'true' || Boolean(el?.disabled);
      })
      .catch(() => false);
    if (disabled) {
      throw new Error(`SKU已禁用/售罄：${selection.propName}=${selection.valueName}`);
    }

    // 如果该规格已处于选中状态，直接跳过（常见于“同色多尺码”连续加购，能显著提速且更像真人）
    const alreadySelected = await this.page
      .evaluate((vid) => {
        const panel = document.querySelector('[id*="SkuPanel"]');
        if (!panel) return false;

        const nodes = Array.from(
          panel.querySelectorAll(
            `[data-vid="${vid}"], [data-value="${vid}"], [data-id="${vid}"], [data-sku-value="${vid}"]`
          )
        );
        if (nodes.length === 0) return false;

        const selectedAttr = (el: Element | null) => {
          if (!el) return false;
          const get = (n: string) => el.getAttribute(n);
          return (
            get('aria-selected') === 'true' ||
            get('aria-checked') === 'true' ||
            get('aria-pressed') === 'true' ||
            get('data-selected') === 'true'
          );
        };

        const hasSelectedClass = (el: Element | null) => {
          if (!el) return false;
          const cls = String(el.getAttribute('class') || '');
          return /selected|active|checked|isSelected|chosen|current/i.test(cls);
        };

        for (const node of nodes) {
          const el = node as Element;
          const target =
            el.closest('button,a,[role="button"]') ||
            el.closest('[class*="valueItem"]') ||
            el.closest('[class*="sku"]') ||
            el;

          if (selectedAttr(el) || selectedAttr(target)) return true;
          if (hasSelectedClass(el) || hasSelectedClass(target)) return true;

          let cur: Element | null = target;
          for (let i = 0; i < 4 && cur; i++) {
            if (selectedAttr(cur) || hasSelectedClass(cur)) return true;
            cur = cur.parentElement;
          }
        }

        return false;
      }, selection.valueId)
      .catch(() => false);

    if (alreadySelected) {
      await this.humanSimulator.sleep(randomDelay(80, 180));
      return;
    }

    await element.scrollIntoViewIfNeeded().catch(() => {});
    await this.humanSimulator.sleep(randomDelay(120, 280));
    const handle = await element.elementHandle().catch(() => null);
    if (handle) {
      try {
        await this.humanSimulator.moveToElement(handle);
      } catch {
        // ignore mouse-move failures
      }
    }
    await this.humanSimulator.sleep(randomDelay(80, 220));

    for (let attempt = 1; attempt <= 4; attempt++) {
      // 第一次点击前已做过 tips/遮罩清理；后续仅在未生效时再清理一次，避免重复拖慢节奏
      if (attempt > 1) {
        await this.closeFeatureTips();
        await this.waitForOverlaysCleared();
      }

      await this.clickLocatorAsHuman(element);
      await this.humanSimulator.sleep(randomDelay(150, 360));

      const applied = await this.page
        .waitForFunction(
          (vid) => {
            const panel = document.querySelector('[id*="SkuPanel"]');
            if (!panel) return true;

            const nodes = Array.from(panel.querySelectorAll(`[data-vid="${vid}"], [data-value="${vid}"], [data-id="${vid}"], [data-sku-value="${vid}"]`));
            if (nodes.length === 0) return false;

            const selectedAttr = (el: Element | null) => {
              if (!el) return false;
              const get = (n: string) => el.getAttribute(n);
              return (
                get('aria-selected') === 'true' ||
                get('aria-checked') === 'true' ||
                get('aria-pressed') === 'true' ||
                get('data-selected') === 'true'
              );
            };

            const hasSelectedClass = (el: Element | null) => {
              if (!el) return false;
              const cls = String(el.getAttribute('class') || '');
              return /selected|active|checked|isSelected|chosen|current/i.test(cls);
            };

            for (const node of nodes) {
              const target =
                node.closest('button,a,[role="button"]') ||
                node.closest('[class*="valueItem"]') ||
                node.closest('[class*="sku"]') ||
                (node as Element);

              if (selectedAttr(node as Element) || selectedAttr(target)) return true;
              if (hasSelectedClass(node as Element) || hasSelectedClass(target)) return true;

              // 某些页面把选中态打在父级/祖先上
              let cur: Element | null = target;
              for (let i = 0; i < 4 && cur; i++) {
                if (selectedAttr(cur) || hasSelectedClass(cur)) return true;
                cur = cur.parentElement;
              }
            }

            return false;
          },
          selection.valueId,
          { timeout: 2200 }
        )
        .then(() => true)
        .catch(() => false);

      if (applied) break;

      // 最后一轮兜底：如果页面阻止点击（例如透明遮罩），用一次 locator click 作为后备
      if (attempt === 4) {
        await element.click({ timeout: 1500 }).catch(() => {});
      }

      if (attempt === 4) {
        console.warn(
          `[AutoCart] 规格选择可能未生效: ${selection.propName}=${selection.valueName} (valueId=${selection.valueId})`
        );
        await this.maybeSaveDebugArtifacts('sku_select_not_applied', {
          valueId: selection.valueId,
          propName: selection.propName,
          valueName: selection.valueName,
        });
      }
    }

    await this.humanSimulator.sleep(randomDelay(120, 300));
  }

  private async waitForPriceStable(): Promise<void> {
    const priceSelectors = [
      '.price',
      '.final-price',
      '[class*="Price"]',
      '.highlightPrice--LlVWiXXs .text--LP7Wf49z'
    ];

    let priceElement = null;
    for (const selector of priceSelectors) {
      priceElement = await this.page.$(selector).catch(() => null);
      if (priceElement) break;
    }

    if (!priceElement) return;

    let lastPrice = '';
    let stableCount = 0;

    for (let i = 0; i < 15; i++) {
      const currentPrice = await priceElement.textContent().catch(() => '') || '';

      if (currentPrice === lastPrice) {
        stableCount++;
        if (stableCount >= 2) break;
      } else {
        stableCount = 0;
        lastPrice = currentPrice;
      }

      await this.humanSimulator.sleep(80);
    }
  }

  private async getMiniCartCount(): Promise<number | null> {
    const selectors = [
      '#J_MiniCartNum',
      '[id*="MiniCartNum"]',
      '[class*="mini-cart"] #J_MiniCartNum',
      '[class*="miniCart"] [class*="Num"]',
    ];

    for (const selector of selectors) {
      const text = await this.page.locator(selector).first().textContent().catch(() => null);
      if (!text) continue;
      const num = parseInt(text.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(num)) return num;
    }

    return null;
  }

  private async waitForAddCartSuccess(beforeCount: number | null): Promise<boolean> {
    const timeoutMs = 8000;

    // 比起反复读取 body.innerText，优先用定位器等待“成功提示/Toast”出现（更快、更稳定）
    const successTextRe = /(成功(加入|添加|放入).{0,6}购物车|已(加入|添加|放入).{0,6}购物车|加入购物车成功|已放入购物车)/;
    const successTextPromise = Promise.any([
      this.page.getByText(successTextRe).first().waitFor({ state: 'visible', timeout: timeoutMs }),
      this.page.locator('[role="alert"]').filter({ hasText: successTextRe }).first().waitFor({ state: 'visible', timeout: timeoutMs }),
      this.page.locator('[class*="toast"], [class*="message"], [class*="notice"], .ant-message, .next-message')
        .filter({ hasText: successTextRe })
        .first()
        .waitFor({ state: 'visible', timeout: timeoutMs }),
    ])
      .then(() => true)
      .catch(() => false);

    const countIncreasePromise =
      beforeCount == null
        ? Promise.resolve(false)
        : this.page
            .waitForFunction(
              (prev) => {
                const getNum = (sel: string) => {
                  const el = document.querySelector(sel);
                  if (!el) return null;
                  const t = (el.textContent || '').replace(/[^\d]/g, '');
                  if (!t) return null;
                  const n = Number.parseInt(t, 10);
                  return Number.isFinite(n) ? n : null;
                };

                const current = getNum('#J_MiniCartNum') ?? getNum('[id*="MiniCartNum"]');
                return current != null && current > prev;
              },
              beforeCount,
              { timeout: timeoutMs }
            )
            .then(() => true)
            .catch(() => false);

    // 只要任意一个信号成立就立刻返回，避免其中一个信号缺失导致固定等待满 timeoutMs（加购会显著变慢）
    const never = new Promise<boolean>(() => {});
    return await Promise.race([
      successTextPromise.then((ok) => (ok ? true : never)),
      countIncreasePromise.then((ok) => (ok ? true : never)),
      this.page.waitForTimeout(timeoutMs).then(() => false),
    ]);
  }

  private async getAddCartFailureReason(): Promise<string | null> {
    const candidates: string[] = [];

    const bodyText = await this.page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    if (bodyText) candidates.push(bodyText);

    const toastSelectors = [
      '[role="alert"]',
      '[class*="toast"]',
      '[class*="message"]',
      '[class*="notice"]',
      '.ant-message',
      '.ant-notification',
      '.next-message',
    ];

    for (const selector of toastSelectors) {
      const t = await this.page.locator(selector).first().innerText({ timeout: 800 }).catch(() => '');
      if (t) candidates.push(t);
    }

    const text = candidates.join('\n');
    if (!text) return null;

    const rules: Array<{ re: RegExp; reason: string }> = [
      { re: /(请选择|请先选择|请选择您要的).*(规格|属性|颜色|尺码|尺寸|型号|版本|套餐|款式)/, reason: '未选择完整规格' },
      { re: /(请选择|请先选择).*(规格|属性)/, reason: '未选择完整规格' },
      { re: /(库存不足|已售罄|无货|补货|暂时缺货)/, reason: '库存不足/已售罄' },
      { re: /(操作太频繁|系统繁忙|休息一下|太火爆|请稍后再试)/, reason: '系统繁忙/操作频繁' },
      { re: /(请先登录|重新登录|登录失效|扫码登录|密码登录|安全验证|验证码|滑块)/, reason: '登录状态失效/触发验证' },
      { re: /(下架|不存在|失效|已删除|已结束)/, reason: '商品不可用/已下架' },
    ];

    for (const rule of rules) {
      if (rule.re.test(text)) return rule.reason;
    }

    return null;
  }

  private async getMissingSkuDimensions(): Promise<string[]> {
    return this.page
      .evaluate(() => {
        const skuPanel = document.querySelector('[id*="SkuPanel"]');
        if (!skuPanel) return [];

        const normalizeText = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim();

        const containerSelectors = [
          '[class*="propItem"]',
          '[class*="Property"]',
          '[class*="skuItem"]',
          '[class*="skuLine"]',
          'dl',
        ];

        const containers = Array.from(skuPanel.querySelectorAll(containerSelectors.join(','))).filter((el) =>
          el.querySelector('[data-vid]')
        );

        const isSelectedDeep = (el: Element) => {
          const get = (node: Element | null, name: string) => (node ? node.getAttribute(name) : null);
          const hasSelectedAttr = (node: Element | null) =>
            get(node, 'aria-selected') === 'true' ||
            get(node, 'aria-checked') === 'true' ||
            get(node, 'aria-pressed') === 'true' ||
            get(node, 'data-selected') === 'true';

          const hasSelectedClass = (node: Element | null) => {
            if (!node) return false;
            const cls = String(node.getAttribute('class') || '');
            return /selected|active|checked|isSelected|chosen|current/i.test(cls);
          };

          const target =
            el.closest('button,a,[role="button"]') ||
            el.closest('[class*="valueItem"]') ||
            el.closest('[class*="sku"]') ||
            el;

          if (hasSelectedAttr(el) || hasSelectedAttr(target)) return true;
          if (hasSelectedClass(el) || hasSelectedClass(target)) return true;

          let cur: Element | null = target;
          for (let i = 0; i < 4 && cur; i++) {
            if (hasSelectedAttr(cur) || hasSelectedClass(cur)) return true;
            cur = cur.parentElement;
          }

          return false;
        };

        const missing: string[] = [];

        containers.forEach((container, idx) => {
          const labelEl =
            container.querySelector('[class*="propName"]') ||
            container.querySelector('[class*="name"]') ||
            container.querySelector('dt') ||
            container.querySelector('label');

          const label = normalizeText(labelEl?.textContent) || `规格${idx + 1}`;
          const valueNodes = Array.from(container.querySelectorAll('[data-vid]'));
          const hasSelected = valueNodes.some((n) => isSelectedDeep(n));
          if (!hasSelected) missing.push(label);
        });

        return Array.from(new Set(missing));
      })
      .catch(() => []);
  }

  private async closeAddCartModal(): Promise<void> {
    try {
      console.log('[AutoCart] 关闭加购弹窗...');

      // 快速判断：页面没有任何遮罩/弹层/提示时，避免无意义的 ESC 等操作（会拖慢每个SKU的节奏）
      const maybeHasModal = await this.page
        .locator(
          [
            '.CommonMask--UmpuIa8a',
            '[class*="mask"]',
            '[class*="overlay"]',
            '[role="dialog"]',
            '[aria-modal="true"]',
            '[role="alert"]',
            '[class*="toast"]',
            '[class*="popup"]',
            '[class*="Modal"]',
            '[class*="Dialog"]',
            '[class*="message"]',
            '[class*="notification"]',
          ].join(', ')
        )
        .first()
        .isVisible()
        .catch(() => false);
      if (!maybeHasModal) return;

      // 策略1：先尝试识别小弹窗（第二次加购时出现的简洁弹窗）
      const miniPopupSelectors = [
        // 基于文本内容的小弹窗识别
        'div:has-text("成功加入购物车")',
        'div:has-text("已添加到购物车")',
        'div:has-text("已放入购物车")',
        '[class*="message"]:has-text("成功加入购物车")',
        '[class*="message"]:has-text("已添加到购物车")',
        '[class*="toast"]:has-text("成功加入购物车")',
        '[class*="toast"]:has-text("已添加到购物车")',
        '[class*="notice"]:has-text("成功加入购物车")',
        '[class*="notice"]:has-text("已添加到购物车")',
        '[class*="popup"]:has-text("成功加入购物车")',
        '[class*="popup"]:has-text("已添加到购物车")',
        // 通用小弹窗容器
        '[class*="mini-popup"]',
        '[class*="mini-modal"]',
        '[class*="message-box"]',
        '[class*="notification"]',
        '[role="alert"]',
        '[role="dialog"][class*="mini"]'
      ];

      // 尝试查找小弹窗并关闭（小弹窗通常会自动消失，或需要点击关闭按钮）
      for (const selector of miniPopupSelectors) {
        try {
          const miniPopup = await this.page.$(selector).catch(() => null);
          if (miniPopup) {
            const isVisible = await miniPopup.isVisible().catch(() => false);
            if (isVisible) {
              console.log(`[AutoCart] 检测到小弹窗: ${selector}`);

              // 查找小弹窗内的关闭按钮
              const closeBtn = await miniPopup.$('button, [class*="close"], a[class*="close"], i[class*="close"]').catch(() => null);
              if (closeBtn) {
                const btnVisible = await closeBtn.isVisible().catch(() => false);
                if (btnVisible) {
                  // 滚动到按钮位置
                  try {
                    await closeBtn.scrollIntoViewIfNeeded({ timeout: 2000 });
                    await this.humanSimulator.sleep(randomDelay(200, 400));
                  } catch (scrollError) {
                    console.log('[AutoCart] 无法滚动到小弹窗关闭按钮');
                  }

                  console.log('[AutoCart] 点击小弹窗关闭按钮');
                  await closeBtn.click({ timeout: 3000 }).catch(() => {});
                  await this.humanSimulator.sleep(randomDelay(250, 600));
                  console.log('[AutoCart] 小弹窗已关闭');
                  return;
                }
              }

              // 等待弹窗自动消失（不再点击外部区域，避免误点击其他商品）
              console.log('[AutoCart] 等待小弹窗自动消失...');
              await this.humanSimulator.sleep(randomDelay(1500, 2500));

              // 检查是否已经消失
              const stillVisible = await miniPopup.isVisible().catch(() => false);
              if (!stillVisible) {
                console.log('[AutoCart] 小弹窗已自动消失');
                return;
              }
            }
          }
        } catch (e) {
          // 忽略单个选择器错误，继续尝试下一个
        }
      }

      // 策略2：传统的大弹窗关闭按钮
      const closeSelectors = [
        // 成功弹窗常见操作（继续购物/再逛逛）
        'button:has-text("继续购物")',
        'a:has-text("继续购物")',
        'button:has-text("再逛逛")',
        'a:has-text("再逛逛")',
        'button:has-text("继续逛")',
        'a:has-text("继续逛")',
        // 遮罩层关闭按钮
        '.CommonMask--UmpuIa8a [class*="close"]',
        '.CommonMask--UmpuIa8a .close',
        // X 图标
        '[class*="icon-guanbi"]',
        'i.icon-guanbi',
        // 通用关闭按钮
        'button[class*="close"]',
        '.modal-close',
        '.popup-close',
        '[aria-label="关闭"]',
        '[title="关闭"]',
        // 按钮文本
        'button:has-text("关闭")',
        'button:has-text("×")',
        'a:has-text("×")',
        // 淘宝特定选择器
        '[class*="Dialog"] [class*="close"]',
        '[class*="Modal"] [class*="close"]',
      ];

      for (const selector of closeSelectors) {
        try {
          const closeBtn = await this.page.$(selector).catch(() => null);
          if (closeBtn) {
            const isVisible = await closeBtn.isVisible().catch(() => false);
            if (isVisible) {
              // 滚动到按钮位置
              try {
                await closeBtn.scrollIntoViewIfNeeded({ timeout: 2000 });
                await this.humanSimulator.sleep(randomDelay(200, 400));
              } catch (scrollError) {
                console.log('[AutoCart] 无法滚动到关闭按钮');
              }

              console.log(`[AutoCart] 找到关闭按钮: ${selector}`);
              await closeBtn.click({ timeout: 3000 }).catch(() => {});
              await this.humanSimulator.sleep(randomDelay(250, 600));
              console.log('[AutoCart] 弹窗已关闭');
              return;
            }
          }
        } catch (e) {
          // 忽略单个选择器错误
        }
      }

      // 策略3：点击遮罩层外部
      const mask = await this.page.$('.CommonMask--UmpuIa8a, [class*="mask"], [class*="overlay"]').catch(() => null);
      if (mask) {
        const maskVisible = await mask.isVisible().catch(() => false);
        if (maskVisible) {
          console.log('[AutoCart] 点击遮罩关闭弹窗...');
          await mask.click({ timeout: 2000 }).catch(() => {});
          await this.humanSimulator.sleep(randomDelay(200, 450));

          // 检查是否成功关闭
          const stillVisible = await mask.isVisible().catch(() => false);
          if (!stillVisible) {
            console.log('[AutoCart] 通过点击遮罩关闭弹窗');
            return;
          }
        }
      }

      // 策略4：按 ESC 键
      console.log('[AutoCart] 尝试按 ESC 关闭弹窗...');
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.humanSimulator.sleep(randomDelay(200, 350));

      console.log('[AutoCart] 已尝试关闭弹窗');
    } catch (error) {
      console.warn('[AutoCart] 关闭弹窗失败:', error);
      // 不抛出错误，继续执行
    }
  }

  /**
   * 关闭淘宝页面上的各种新功能提示弹窗
   * 这些弹窗会遮挡SKU选择按钮，导致点击失败
   */
  private async closeFeatureTips(): Promise<void> {
    try {
      // 先做一次“轻量探测”，避免在绝大多数没有弹窗的情况下反复深度遍历（会显著拖慢 48+ SKU 的加购）
      const now = Date.now();
      const maskLocator = this.page.locator('.CommonMask--UmpuIa8a, [class*="mask" i], [class*="overlay" i], [class*="Modal" i]').first();
      const maskVisible = await maskLocator.isVisible().catch(() => false);

      // 优先检测"新增大图查看功能"弹窗 - 这是一个特定的功能提示弹窗
      const bigImageTipLocator = this.page.locator('text=新增大图查看功能, text=大图查看功能, text=切换大图模式').first();
      const bigImageTipVisible = await bigImageTipLocator.isVisible().catch(() => false);

      const quickCloseLocator = this.page
        .locator(
          [
            // 常见引导按钮
            'button:has-text("知道了")',
            'button:has-text("我知道了")',
            'button:has-text("好的")',
            'button:has-text("明白了")',
            'button:has-text("关闭")',
            // 有些页面把按钮做成 div/span
            '[role="button"]:has-text("知道了")',
            'div:has-text("知道了")',
            'span:has-text("知道了")',
          ].join(',')
        )
        .first();
      const quickVisible = await quickCloseLocator.isVisible().catch(() => false);

      // 详细日志：记录检测结果
      console.log(`[AutoCart] 功能提示检测: maskVisible=${maskVisible}, bigImageTipVisible=${bigImageTipVisible}, quickVisible=${quickVisible}`);

      // 没有任何迹象时直接返回；每 15s 允许做一次深度扫描兜底（防止偶发样式变体漏检）
      if (!maskVisible && !quickVisible && !bigImageTipVisible && now - this.lastTipDeepScanAt < 15_000) {
        console.log('[AutoCart] 未检测到功能提示，跳过...');
        return;
      }

      this.lastTipDeepScanAt = now;
      console.log('[AutoCart] 检查功能提示弹窗...');

      // 优先处理"新增大图查看功能"弹窗
      if (bigImageTipVisible) {
        console.log('[AutoCart] 检测到“新增大图查看功能”弹窗，尝试关闭...');
        // 精确匹配淘宝的"知道了"按钮 - 它是一个 <div class="tipBtn--xxx">知道了</div>
        const tipCloseSelectors = [
          // 精确匹配淘宝的类名模式
          'div[class*="tipBtn"]',
          '.tipBtn--nZQ9xhek',
          // 在弹窗容器内查找
          '[class*="popoverContent"] div:has-text("知道了")',
          '[class*="contentWrap"] div:has-text("知道了")',
          // 通用选择器
          'div:has-text("知道了"):not(:has(*))',
          'span:has-text("知道了")',
          'button:has-text("知道了")',
          '[role="button"]:has-text("知道了")',
        ];
        let closed = false;
        for (const selector of tipCloseSelectors) {
          const closeBtn = this.page.locator(selector).first();
          const visible = await closeBtn.isVisible().catch(() => false);
          console.log(`[AutoCart] 尝试 selector="${selector}": visible=${visible}`);
          if (visible) {
            try {
              const box = await closeBtn.boundingBox().catch(() => null);
              console.log(`[AutoCart] 按钮区域:`, box);
              await closeBtn.scrollIntoViewIfNeeded().catch(() => {});
              await this.humanSimulator.sleep(randomDelay(100, 200));
              await closeBtn.click({ timeout: 2000, force: true });
              console.log('[AutoCart] 已关闭“新增大图查看功能”弹窗');
              await this.humanSimulator.sleep(randomDelay(200, 400));
              await this.waitForOverlaysCleared(2000);
              closed = true;
              break;
            } catch (e) {
              console.warn('[AutoCart] 通过 selector 关闭失败:', selector, e);
            }
          }
        }
        if (!closed) {
          console.log('[AutoCart] selector 无法关闭弹窗，尝试 page.evaluate...');
          const clicked = await this.page.evaluate(() => {
            // 优先查找 tipBtn 类名的元素
            const tipBtn = document.querySelector('div[class*="tipBtn"]') as HTMLElement;
            if (tipBtn && tipBtn.textContent?.trim() === '知道了') {
              tipBtn.click();
              return true;
            }
            // 兜底：查找所有文本为"知道了"的元素
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
              const text = el.textContent?.trim();
              if (text === '知道了' && el instanceof HTMLElement) {
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  el.click();
                  return true;
                }
              }
            }
            return false;
          }).catch(() => false);
          if (clicked) {
            console.log('[AutoCart] 已通过 page.evaluate 关闭弹窗');
            await this.humanSimulator.sleep(randomDelay(200, 400));
          } else {
            console.log('[AutoCart] page.evaluate 未找到“知道了”按钮');
          }
        }
      }

      const closeTexts = ['知道了', '我知道了', '好的', '明白了', '关闭', '我知道', '继续逛', '继续购物', '再逛逛'];
      const closeSelectors = [
        '[class*="tipClose" i]',
        '[class*="guideClose" i]',
        '.guide-close',
        '.tip-close',
        '.feature-tip-close',
        '[aria-label*="关闭"]',
        '[title*="关闭"]',
        '[class*="close" i]',
      ];

      const scopes: any[] = [this.page, ...this.page.frames()];

      // 改进的点击函数：遍历所有匹配元素，找到第一个可见的再点击；只执行一次点击
      const clickLocator = async (locator: any, label: string): Promise<boolean> => {
        try {
          const count = await locator.count().catch(() => 0);
          for (let idx = 0; idx < Math.min(count, 5); idx++) {
            const el = locator.nth(idx);
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;

            await el.scrollIntoViewIfNeeded().catch(() => {});
            await this.humanSimulator.sleep(randomDelay(120, 260));

            // 只执行一次点击：先尝试 human click，失败再用 locator click
            const humanClickSuccess = await this.clickLocatorAsHuman(el)
              .then(() => true)
              .catch(() => false);
            if (!humanClickSuccess) {
              await el.click({ timeout: 1200 }).catch(() => {});
            }
            console.log(`[AutoCart] 已关闭功能提示: ${label} (index ${idx})`);
            return true;
          }
          return false;
        } catch {
          return false;
        }
      };

      let anyClosed = false;
      for (let round = 0; round < 6; round++) {
        let closedThisRound = false;

        for (const scope of scopes) {
          for (const text of closeTexts) {
            const byRole = scope.getByRole?.('button', { name: text })?.first?.();
            if (byRole && (await clickLocator(byRole, `role=button name=${text}`))) {
              closedThisRound = true;
              break;
            }

            // 有些引导弹窗的“知道了”并不是 button/a（可能是 div/span），用 getByText 兜底
            const byGetTextExact = scope.getByText?.(text, { exact: true })?.first?.();
            if (byGetTextExact && (await clickLocator(byGetTextExact, `getByText exact=${text}`))) {
              closedThisRound = true;
              break;
            }

            const byGetTextLoose = scope.getByText?.(text)?.first?.();
            if (byGetTextLoose && (await clickLocator(byGetTextLoose, `getByText=${text}`))) {
              closedThisRound = true;
              break;
            }

            const byText = scope.locator?.(`button:has-text("${text}"), a:has-text("${text}"), [role="button"]:has-text("${text}")`);
            if (byText && (await clickLocator(byText, `text=${text}`))) {
              closedThisRound = true;
              break;
            }
          }
          if (closedThisRound) break;

          for (const selector of closeSelectors) {
            const loc = scope.locator?.(selector);
            if (loc && (await clickLocator(loc, `selector=${selector}`))) {
              closedThisRound = true;
              break;
            }
          }
          if (closedThisRound) break;
        }

        if (!closedThisRound) break;

        anyClosed = true;
        await this.humanSimulator.sleep(randomDelay(220, 420));
        await this.waitForOverlaysCleared(2000);
      }

      if (!anyClosed) {
        // 如果发现遮罩层，也尝试点击关闭（避免弹窗关闭后残留遮罩）
        if (maskVisible) {
          const masks = await this.page.$$('[class*="mask"], [class*="overlay"]').catch(() => []);
          for (const mask of masks) {
            const isVisible = await mask.isVisible().catch(() => false);
            if (isVisible) {
              console.log('[AutoCart] 尝试关闭遮罩层...');
              await mask.click({ timeout: 1000 }).catch(() => {});
              await this.humanSimulator.sleep(250);
              break;
            }
          }

          // 最后兜底：只有在确实有遮罩/弹层迹象时才按 ESC，避免无意义地反复按键
          console.log('[AutoCart] 尝试用 ESC 关闭提示...');
          const t = Date.now();
          if (t - this.lastTipEscapeAt > 900) {
            this.lastTipEscapeAt = t;
            await this.page.keyboard.press('Escape').catch(() => {});
            await this.humanSimulator.sleep(randomDelay(120, 240));
          }
        }
      }

      console.log('[AutoCart] 功能提示检查完成');
    } catch (error) {
      console.warn('[AutoCart] 关闭功能提示失败:', error);
      // 不抛出错误，继续执行
    }
  }

  private async extractCartItemIdFromRequest(): Promise<string | null> {
    return null;
  }

  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * 从当前购物车页面提取指定商品的数据
   */
  private async extractCartDataFromCurrentPage(taobaoId: string): Promise<any[]> {
    if (!this.page) return [];

    try {
      // 等待购物车内容加载
      await this.page.waitForSelector('.trade-cart-item-info', { timeout: 10000 }).catch(() => {});

      const products = await this.page.evaluate((targetTaobaoId) => {
        const items: any[] = [];
        const cartItems = Array.from(document.querySelectorAll('.trade-cart-item-info'));

        cartItems.forEach((item) => {
          // 从链接中提取ID
          const linkEl = item.querySelector('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');
          const href = linkEl?.getAttribute('href') || '';
          const taobaoIdMatch = href.match(/[?&]id=(\d+)/);
          const skuIdMatch = href.match(/[?&]skuId=(\d+)/);
          const itemTaobaoId = taobaoIdMatch ? taobaoIdMatch[1] : '';

          // 只提取目标商品
          if (itemTaobaoId !== targetTaobaoId) return;

          const skuId = skuIdMatch ? skuIdMatch[1] : '';

          // 标题
          const titleEl = item.querySelector('a.title--dsuLK9IN');
          const title = titleEl?.textContent?.trim() || '';

          // 图片
          const imageEl = item.querySelector('img.image--MC0kGGgi');
          const imageSrc = imageEl?.getAttribute('src') || null;
          const imageUrl = imageSrc ? (imageSrc.startsWith('//') ? 'https:' + imageSrc : imageSrc) : null;

          // 价格
          const priceContainer = item.querySelector('.trade-cart-item-price');
          const priceContainers = priceContainer ? Array.from(priceContainer.querySelectorAll('.trade-price-container')) : [];

          let finalPrice = 0;
          let originalPrice: number | null = null;

          if (priceContainers.length > 0) {
            const firstContainer = priceContainers[0];
            const priceInteger1 = firstContainer?.querySelector('.trade-price-integer')?.textContent?.trim() || '0';
            const priceDecimal1 = firstContainer?.querySelector('.trade-price-decimal')?.textContent?.trim() || '0';
            finalPrice = parseFloat(`${priceInteger1}.${priceDecimal1}`);

            if (priceContainers.length > 1) {
              const secondContainer = priceContainers[1];
              const priceInteger2 = secondContainer?.querySelector('.trade-price-integer')?.textContent?.trim() || '0';
              const priceDecimal2 = secondContainer?.querySelector('.trade-price-decimal')?.textContent?.trim() || '0';
              originalPrice = parseFloat(`${priceInteger2}.${priceDecimal2}`);
            }
          }

          // SKU属性
          const skuEl = item.querySelector('.trade-cart-item-sku-old');
          const skuLabels = skuEl ? Array.from(skuEl.querySelectorAll('.label--T4deixnF')) : [];
          const skuProperties = skuLabels.map(label => (label as Element).textContent?.trim() || '').join(' ');

          items.push({
            taobaoId: itemTaobaoId,
            skuId,
            skuProperties,
            title,
            imageUrl,
            finalPrice,
            originalPrice,
            quantity: 1,
            cartItemId: `${itemTaobaoId}_${skuId}`
          });
        });

        return items;
      }, taobaoId);

      return products;
    } catch (error: any) {
      console.error('[AutoCart] 提取购物车数据失败:', error?.message);
      return [];
    }
  }
}

export const autoCartAdder = new AutoCartAdder();
