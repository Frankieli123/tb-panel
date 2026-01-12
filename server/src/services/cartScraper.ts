import { Page } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { sharedBrowserManager } from './sharedBrowserManager.js';
import { HumanSimulator, randomDelay, randomRange } from './humanSimulator.js';
import { notificationService } from './notification.js';
import { frontendPush } from './frontendPush.js';
import { calculatePriceDrop } from '../utils/helpers.js';

const prisma = new PrismaClient();

const CART_BASE_SKU_ID = '__BASE__';

export interface CartProduct {
  taobaoId: string;
  skuId: string;
  skuProperties: string;
  title: string;
  imageUrl: string | null;
  finalPrice: number;
  originalPrice: number | null;
  quantity: number;
  cartItemId: string;
}

export interface CartScrapeResult {
  success: boolean;
  products: CartProduct[];
  total: number;
  uiTotalCount?: number | null;
  error?: string;
}

export class CartScraper {
  private readonly keepOpen = /^(1|true)$/i.test(String(process.env.CART_SCRAPER_KEEP_OPEN ?? 'true'));
  private mutex: Promise<void> = Promise.resolve();

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => (release = resolve));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private isFatalSessionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error ?? '');
    return (
      /Target closed|has been closed|Browser has been closed|Session closed|Connection closed/i.test(msg) ||
      /Navigation failed because page crashed/i.test(msg)
    );
  }

  private async getOrCreateSession(accountId: string, cookies?: string): Promise<{
    context: any;
    page: Page;
    human: HumanSimulator;
  }> {
    // 使用共享浏览器管理器
    const session = await sharedBrowserManager.getOrCreateSession(accountId, cookies);
    console.log(`[CartScraper] 使用共享浏览器会话 accountId=${accountId}`);
    return session;
  }

  private async checkAndNotify(
    productId: string,
    oldPrice: number,
    newPrice: number,
    drop: { amount: number; percent: number },
    userId?: string | null
  ): Promise<void> {
    try {
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) return;

      let userConfigs: any[] = [];
      if (userId) {
        let cfg = await (prisma as any).userNotificationConfig.findUnique({
          where: { userId },
        });

        if (!cfg) {
          cfg = await (prisma as any).userNotificationConfig.create({
            data: { userId },
          });
        }

        userConfigs = [cfg];
      } else {
        userConfigs = await (prisma as any).userNotificationConfig.findMany({
          where: {
            OR: [
              { emailEnabled: true },
              { wechatEnabled: true },
              { dingtalkEnabled: true },
              { feishuEnabled: true },
            ],
          },
        });
      }

      if (!userConfigs.length) return;

      const isPriceDrop = newPrice < oldPrice;
      const isPriceUp = newPrice > oldPrice;

      let anyTriggered = false;
      for (const cfg of userConfigs) {
        const threshold = parseFloat(cfg.triggerValue.toString());

        const shouldNotifyDrop =
          isPriceDrop && (cfg.triggerType === 'AMOUNT'
            ? drop.amount >= threshold
            : drop.percent >= threshold);

        const shouldNotifyUp =
          isPriceUp && cfg.notifyOnPriceUp && (cfg.triggerType === 'AMOUNT'
            ? Math.abs(drop.amount) >= threshold
            : Math.abs(drop.percent) >= threshold);

        if (!shouldNotifyDrop && !shouldNotifyUp) continue;

        anyTriggered = true;
        await notificationService.sendPriceChangeNotification({
          product,
          oldPrice,
          newPrice,
          config: cfg,
          change: drop,
          isPriceUp,
        });
      }

      if (anyTriggered) {
        await notificationService.sendWecomAppPriceChangeNotification({
          product,
          oldPrice,
          newPrice,
          change: drop,
          isPriceUp,
        });
      }
    } catch (error) {
      console.error('[CartScraper] 通知发送失败:', error);
    }
  }

  private async makeCartPageMoreHuman(page: Page, human: HumanSimulator): Promise<void> {
    // 轻微鼠标/滚动，让行为更接近真人阅读购物车列表
    await human.occasionalWander().catch(() => {});
    if (Math.random() < 0.6) {
      await human.randomScroll({ distance: randomRange(120, 360) }).catch(() => {});
      if (Math.random() < 0.35) {
        await page.mouse.wheel(0, -randomRange(80, 220)).catch(() => {});
      }
    }

    // 简单兜底：尝试关闭遮罩/弹层（避免影响读取DOM）
    await page.keyboard.press('Escape').catch(() => {});
    const mask = page.locator('.CommonMask--UmpuIa8a, [class*="mask"], [class*="overlay"]').first();
    const maskVisible = await mask.isVisible().catch(() => false);
    if (maskVisible) {
      await mask.click({ timeout: 1000 }).catch(() => {});
    }
  }

  private isAuthOrChallengeUrl(url: string): boolean {
    return /login\.taobao\.com|login\.tmall\.com|passport\.taobao\.com|sec\.taobao\.com|captcha|verify|risk/i.test(url);
  }

  private async assertNotAuthPage(page: Page, stage: string): Promise<void> {
    const url = page.url();
    if (this.isAuthOrChallengeUrl(url)) {
      throw new Error(`需要登录/验证（${stage}）：${url}`);
    }

    const title = await page.title().catch(() => '');
    if (/(\u767b\u5f55|Login|\u5b89\u5168\u9a8c\u8bc1|\u9a8c\u8bc1\u7801)/.test(title) && /taobao|tmall|alibaba/i.test(url)) {
      throw new Error(`需要登录/验证（${stage}）：${url}`);
    }

    const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    if (
      /(\u626b\u7801\u767b\u5f55|\u5bc6\u7801\u767b\u5f55|\u77ed\u4fe1\u767b\u5f55|\u5b89\u5168\u9a8c\u8bc1|\u9a8c\u8bc1\u7801|\u6ed1\u5757|\u8bf7\u5148\u767b\u5f55)/.test(
        bodyText
      )
    ) {
      throw new Error(`需要登录/验证（${stage}）：${url}`);
    }
  }

  private async refreshCartPage(session: { page: Page; human: HumanSimulator }): Promise<void> {
    const url = session.page.url();
    const isCart = /cart\.taobao\.com\/cart\.htm/i.test(url);

    if (!isCart) {
      await session.human.navigateAsHuman('https://cart.taobao.com/cart.htm');
    } else {
      await session.page
        .reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(async () => {
          await session.page.goto('https://cart.taobao.com/cart.htm', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        });
    }

    await session.page.waitForTimeout(randomDelay(1200, 2400));
    await this.assertNotAuthPage(session.page, 'cart');
    await this.makeCartPageMoreHuman(session.page, session.human);
    await session.page.waitForTimeout(randomDelay(600, 1200));
  }

  async scrapeCart(
    accountId: string,
    cookies?: string,
    options?: { expectedTaobaoIds?: string[] }
  ): Promise<CartScrapeResult> {
    console.log(`[CartScraper] 开始抓取购物车 accountId=${accountId}`);

    return this.runExclusive(async () => {
      let lastErr: any = null;

      // keepOpen 模式下允许一次自愈重试（用户可能手动关掉窗口/页面）
      const maxAttempts = this.keepOpen ? 2 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const session = await this.getOrCreateSession(accountId, cookies);
          await this.refreshCartPage(session);

          const cartData = await this.extractCartData(session.page, options);
          console.log(`[CartScraper] 购物车已抓取 ${cartData.products.length} 条`);

          return {
            success: true,
            products: cartData.products,
            total: cartData.products.length,
            uiTotalCount: cartData.uiTotalCount ?? null,
          };
        } catch (error: any) {
          lastErr = error;
          console.error(`[CartScraper] 抓取失败（第 ${attempt}/${maxAttempts} 次）:`, error);

          const fatal = this.isFatalSessionError(error);
          if (fatal) {
            await sharedBrowserManager.disposeSession(accountId);
            continue;
          }

          // 非致命错误：keepOpen 模式下保留 session（下次轮询继续用），否则释放
          if (!this.keepOpen) {
            await sharedBrowserManager.disposeSession(accountId);
          }

          break;
        }
      }

      return {
        success: false,
        products: [],
        total: 0,
        error: lastErr?.message ?? String(lastErr ?? 'unknown'),
      };
    });
  }

  private async extractCartData(
    page: Page,
    options?: { expectedTaobaoIds?: string[] }
  ): Promise<{ products: CartProduct[]; uiTotalCount: number | null }> {
    const productsByKey = new Map<string, CartProduct>();
    const expectedRemaining = new Set<string>(
      (options?.expectedTaobaoIds ?? [])
        .map((x) => String(x || '').trim())
        .filter((x) => /^\d+$/.test(x))
    );

    const uiTotalCount = await page
      .evaluate(() => {
        const toCount = (raw: string | null | undefined): number | null => {
          const digits = String(raw || '')
            .replace(/[^\d]/g, '')
            .trim();
          if (!digits) return null;
          const n = parseInt(digits, 10);
          return Number.isFinite(n) && n >= 0 ? n : null;
        };

        const header = document.querySelector('.trade-cart-header-container') as HTMLElement | null;
        const headerText = header?.textContent || '';
        const m = /全部商品\s*[（(]\s*(\d{1,6})\s*[）)]/.exec(headerText);
        const n2 = m ? toCount(m[1]) : null;
        if (n2 !== null) return n2;

        const m2 = new RegExp(
          '\u5168\u90e8\u5546\u54c1\\s*[\\(\uff08]\\s*(\\d{1,6})\\s*[\\)\uff09]'
        ).exec(headerText);
        const n3 = m2 ? toCount(m2[1]) : null;
        if (n3 !== null) return n3;

        return null;
      })
      .catch(() => null);

    const extractVisible = async (): Promise<{
      items: CartProduct[];
      scroll: { top: number; height: number; client: number };
    } | null> => {
      return page
        .evaluate(() => {
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

          const items: any[] = [];
          const cartItems = Array.from(document.querySelectorAll('.trade-cart-item-info'));

          for (const item of cartItems) {
            const titleEl = item.querySelector('a.title--dsuLK9IN') as HTMLAnchorElement | null;
            const title = titleEl?.textContent?.trim() || '';

            const imageEl = item.querySelector('img.image--MC0kGGgi');
            const imageSrc = imageEl?.getAttribute('src') || null;
            const imageUrl = imageSrc ? (imageSrc.startsWith('//') ? 'https:' + imageSrc : imageSrc) : null;

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

            const skuEl = item.querySelector('.trade-cart-item-sku-old');
            const skuLabels = skuEl ? Array.from(skuEl.querySelectorAll('.label--T4deixnF')) : [];
            const skuProperties = skuLabels.map((label) => label.textContent?.trim() || '').join(' ').trim();

            const qtyEl =
              (item.querySelector('[class*="quantityNumWrapper"]') as HTMLElement | null) ||
              (item.querySelector('.trade-cart-item-quantity [title*="数量"]') as HTMLElement | null) ||
              (item.querySelector('.trade-cart-item-quantity') as HTMLElement | null);
            const qtyRaw = (qtyEl?.getAttribute('title') || qtyEl?.textContent || '').trim();
            const qtyMatch = /(\d{1,6})/.exec(qtyRaw);
            const quantity = Math.max(1, qtyMatch ? parseInt(qtyMatch[1], 10) : 1);

            const linkEl =
              titleEl ||
              (item.querySelector('a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"], a[href*="/i"]') as HTMLAnchorElement | null) ||
              (item.querySelector('a[href*="item.htm?id="], a[href*="?id="]') as HTMLAnchorElement | null);
            const hrefRaw = linkEl?.getAttribute('href') || '';
            const href = hrefRaw.startsWith('//') ? 'https:' + hrefRaw : hrefRaw;

            const taobaoIdMatch =
              href.match(/[?&]id=(\d+)/) ||
              href.match(/\/i(\d+)\.htm/) ||
              href.match(/item\/(\d+)\.htm/);
            const skuIdMatch = href.match(/[?&]skuId=(\d+)/);

            let taobaoId = taobaoIdMatch ? taobaoIdMatch[1] : '';
            let skuId = skuIdMatch ? skuIdMatch[1] : '';

            if (!taobaoId || !skuId) {
              const root = (item.closest?.('[data-id],[data-item-id],[data-itemid],[data-itemId],[data-taobao-id]') as HTMLElement | null) || (item as HTMLElement);

              if (!taobaoId) {
                const dataId =
                  root.getAttribute('data-taobao-id') ||
                  root.getAttribute('data-item-id') ||
                  root.getAttribute('data-itemid') ||
                  root.getAttribute('data-id') ||
                  '';
                if (/^\d+$/.test(dataId)) taobaoId = dataId;
              }

              if (!skuId) {
                const dataSku =
                  root.getAttribute('data-sku-id') ||
                  root.getAttribute('data-skuid') ||
                  root.getAttribute('data-sku') ||
                  '';
                if (/^\d+$/.test(dataSku)) skuId = dataSku;
              }
            }

            if (!taobaoId) continue;

            const keySuffix = skuId || skuProperties || '';
            const cartItemId = keySuffix ? `${taobaoId}_${keySuffix}` : taobaoId;

            items.push({
              taobaoId,
              skuId,
              skuProperties,
              title,
              imageUrl,
              finalPrice,
              originalPrice,
              quantity,
              cartItemId,
            });
          }

          const container = findScrollContainer();
          return {
            items,
            scroll: {
              top: container.scrollTop || 0,
              height: container.scrollHeight || 0,
              client: container.clientHeight || window.innerHeight || 0,
            },
          };
        })
        .catch(() => null);
    };

    const scrollBy = async (delta: number): Promise<number> => {
      return page
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

    const hasExpected = expectedRemaining.size > 0;
    const hasUiTotal = typeof uiTotalCount === 'number';
    let maxRounds = hasExpected || hasUiTotal ? 320 : 160;
    const bottomWaitLimit = hasExpected || hasUiTotal ? 20 : 0;

    let stableNoNewRounds = 0;
    let stuckRounds = 0;
    let lastTop: number | null = null;
    let bottomWaits = 0;

    const detectCartEndMarker = async (): Promise<{ hit: boolean; reason: string | null }> => {
      return page
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

    for (let round = 0; round < maxRounds; round++) {
      const snapshot = await extractVisible();
      if (!snapshot) break;

      let added = 0;
      for (const item of snapshot.items) {
        const key = String(item.cartItemId || '').trim();
        if (!key) continue;

        if (!productsByKey.has(key)) {
          productsByKey.set(key, item);
          if (expectedRemaining.has(item.taobaoId)) expectedRemaining.delete(item.taobaoId);
          added++;
          continue;
        }

        const existing = productsByKey.get(key)!;
        if (!existing.title && item.title) existing.title = item.title;
        if (!existing.imageUrl && item.imageUrl) existing.imageUrl = item.imageUrl;
        if ((!existing.finalPrice || existing.finalPrice <= 0) && item.finalPrice > 0) existing.finalPrice = item.finalPrice;
        if (!existing.originalPrice && item.originalPrice) existing.originalPrice = item.originalPrice;
        if (!existing.skuProperties && item.skuProperties) existing.skuProperties = item.skuProperties;
        if (typeof item.quantity === 'number' && item.quantity > 0) existing.quantity = item.quantity;
        if (expectedRemaining.has(existing.taobaoId)) expectedRemaining.delete(existing.taobaoId);
      }

      if (productsByKey.size === 0 && round === 0 && snapshot.items.length === 0) break;

      if (added > 0) bottomWaits = 0;
      stableNoNewRounds = added === 0 ? stableNoNewRounds + 1 : 0;

      const loadedQty = Array.from(productsByKey.values()).reduce(
        (sum, p) => sum + (typeof p.quantity === 'number' ? p.quantity : 1),
        0
      );
      const needsFullLoad = typeof uiTotalCount === 'number' && loadedQty < uiTotalCount;
      if (typeof uiTotalCount === 'number' && stableNoNewRounds >= 1 && loadedQty >= uiTotalCount) break;

      const { top, height, client } = snapshot.scroll;
      const atBottom = height > 0 && client > 0 && top + client >= height - 2;
      if (atBottom) {
        if ((expectedRemaining.size > 0 || needsFullLoad) && bottomWaits < bottomWaitLimit) {
          bottomWaits++;
          stableNoNewRounds = 0;
          await page.waitForTimeout(Math.min(8000, 1200 + bottomWaits * 500)).catch(() => {});
          await scrollBy(-Math.max(260, Math.floor(client * 0.25)));
          await page.waitForTimeout(randomDelay(240, 420)).catch(() => {});
          continue;
        }
        if ((expectedRemaining.size > 0 || needsFullLoad) && bottomWaits >= bottomWaitLimit && stableNoNewRounds >= 1) {
          const end = await detectCartEndMarker();
          if (typeof uiTotalCount === 'number' && loadedQty < uiTotalCount) {
            console.warn(
              `[CartScraper] 购物车滚动结束（${end.reason || 'no-progress'}）loadedQty=${loadedQty} < uiTotalCount=${uiTotalCount}；停止滚动`
            );
          }
          break;
        }
        if (stableNoNewRounds >= 2 && (uiTotalCount === null || loadedQty >= uiTotalCount)) break;
      }

      const step = Math.max(650, Math.min(2400, Math.floor((client || 800) * 0.95)));
      if (height > 0) {
        const estimated = Math.ceil(height / step) + 10;
        maxRounds = Math.min(4000, Math.max(maxRounds, estimated));
      }
      const nextTop = await scrollBy(step);

      if (lastTop !== null && nextTop === lastTop) stuckRounds++;
      else stuckRounds = 0;
      lastTop = nextTop;

      if (stuckRounds >= 2 && stableNoNewRounds >= 1) {
        if ((expectedRemaining.size > 0 || needsFullLoad) && bottomWaits < bottomWaitLimit) {
          bottomWaits++;
          stableNoNewRounds = 0;
          await page.waitForTimeout(Math.min(8000, 1200 + bottomWaits * 500)).catch(() => {});
          await scrollBy(-Math.max(260, Math.floor(step * 0.25)));
          await page.waitForTimeout(randomDelay(240, 420)).catch(() => {});
          continue;
        }
        if ((expectedRemaining.size > 0 || needsFullLoad) && bottomWaits >= bottomWaitLimit) {
          const end = await detectCartEndMarker();
          if (typeof uiTotalCount === 'number' && loadedQty < uiTotalCount) {
            console.warn(
              `[CartScraper] 购物车滚动卡住（${end.reason || 'no-progress'}）loadedQty=${loadedQty} < uiTotalCount=${uiTotalCount}；停止滚动`
            );
          }
          break;
        }
        if (uiTotalCount === null || loadedQty >= uiTotalCount) break;
      }

      await page.waitForTimeout(hasExpected ? randomDelay(380, 780) : randomDelay(240, 520)).catch(() => {});
    }

    return { products: Array.from(productsByKey.values()), uiTotalCount };
  }

  async updatePricesFromCart(
    accountId: string,
    cookies?: string,
    options?: { cartResult?: CartScrapeResult }
  ): Promise<{
    updated: number;
    failed: number;
    missing: number;
  }> {
    console.log(`[CartScraper] 从购物车更新价格 accountId=${accountId}`);

    const accountUserId =
      (await prisma.taobaoAccount.findUnique({
        where: { id: accountId },
        select: { userId: true },
      }))?.userId ?? null;

    // 0. 兼容旧数据：如果还没有 base 记录，自动合并一次
    await this.ensureBaseProducts(accountId);

    // 1. 查询该账号下所有需要监控的 CART 模式商品（base 记录）
    const monitoredProducts = await prisma.product.findMany({
      where: {
        ownerAccountId: accountId,
        monitorMode: 'CART',
        skuId: CART_BASE_SKU_ID,
        isActive: true
      }
    });

    if (monitoredProducts.length === 0) {
      console.log(`[CartScraper] 无监控商品 accountId=${accountId}`);
      return { updated: 0, failed: 0, missing: 0 };
    }

    console.log(`[CartScraper] 找到 ${monitoredProducts.length} 个监控商品`);

    // 2. 从购物车抓取所有商品（或使用外部 Agent 已抓取的数据）
    const cartResult = options?.cartResult ?? (await this.scrapeCart(accountId, cookies));

    if (!cartResult.success) {
      console.error(`[CartScraper] 抓取购物车失败: ${cartResult.error}`);
      return { updated: 0, failed: monitoredProducts.length, missing: 0 };
    }

    console.log(`[CartScraper] 购物车中共有 ${cartResult.products.length} 条`);

    // 3. 建立购物车商品索引 (taobaoId -> CartProduct[])
    const cartByTaobaoId = new Map<string, CartProduct[]>();
    for (const cartProduct of cartResult.products) {
      const taobaoId = String(cartProduct.taobaoId || '').trim();
      if (!taobaoId) continue;
      const list = cartByTaobaoId.get(taobaoId) ?? [];
      list.push(cartProduct);
      cartByTaobaoId.set(taobaoId, list);
    }

    let updated = 0;
    let failed = 0;
    let missing = 0;

    // 4. 遍历所有监控商品，更新 variants 并落 snapshot
    for (const product of monitoredProducts) {
      try {
        const oldPrice =
          product.currentPrice === null || product.currentPrice === undefined
            ? null
            : parseFloat(product.currentPrice.toString());

        const productTaobaoId = String(product.taobaoId || '').trim();
        const cartItems = cartByTaobaoId.get(productTaobaoId) ?? [];

        if (cartItems.length === 0) {
          // 购物车中没有该商品，标记为缺失
          missing++;
          const title = String(product.title || '').trim() || '<untitled>';
          console.log(`[CartScraper] 购物车未找到: ${title} (${productTaobaoId || String(product.taobaoId || '').trim()})`);

          await prisma.product.update({
            where: { id: product.id },
            data: {
              lastError: '购物车中未找到该商品，请重新添加',
              lastCheckAt: new Date()
            }
          });

          continue;
        }

        const latestSnapshot = await prisma.priceSnapshot.findFirst({
          where: { productId: product.id },
          orderBy: { capturedAt: 'desc' }
        });

        const prevRaw = (latestSnapshot as any)?.rawData as any;
        const prevVariants = Array.isArray(prevRaw?.variants) ? prevRaw.variants : [];

        const prevByKey = new Map<string, any>();
        for (const v of prevVariants) {
          const k = String(v?.skuId ?? v?.variantKey ?? v?.skuProperties ?? v?.vidPath ?? '').trim();
          if (!k) continue;
          if (!prevByKey.has(k)) prevByKey.set(k, v);
        }

        const variants = cartItems.map((c) => {
          const prev =
            prevByKey.get(String(c.skuId)) ||
            prevByKey.get(String(c.skuProperties || '').trim()) ||
            null;

          const selections = Array.isArray(prev?.selections) ? prev.selections : [];
          const vidPath =
            typeof prev?.vidPath === 'string'
              ? prev.vidPath
              : selections
                  .map((s: any) => s?.vid)
                  .filter(Boolean)
                  .map((x: any) => String(x))
                  .join(';');

          return {
            skuId: c.skuId || null,
            skuProperties: c.skuProperties || null,
            vidPath,
            selections,
            finalPrice: typeof c.finalPrice === 'number' ? c.finalPrice : null,
            originalPrice: typeof c.originalPrice === 'number' ? c.originalPrice : null,
            thumbnailUrl: c.imageUrl || prev?.thumbnailUrl || null,
          };
        });

        const prices = variants.map((v: any) => v.finalPrice).filter((n: any) => typeof n === 'number' && n > 0);
        const minPrice = prices.length > 0 ? Math.min(...prices) : 0;

        const origs = variants
          .map((v: any) => v.originalPrice)
          .filter((n: any) => typeof n === 'number' && n > 0);
        const minOrig = origs.length > 0 ? Math.min(...origs) : null;

        const first = cartItems[0];

        // 找到匹配的商品，更新价格
        const updatedProduct = await prisma.product.update({
          where: { id: product.id },
          data: {
            currentPrice: minPrice,
            originalPrice: minOrig ?? undefined,
            title: first?.title || undefined,
            imageUrl: first?.imageUrl || undefined,
            lastCheckAt: new Date(),
            lastError: null
          }
        });

        await prisma.priceSnapshot.create({
          data: {
            productId: product.id,
            finalPrice: minPrice,
            originalPrice: minOrig,
            accountId,
            rawData: {
              taobaoId: product.taobaoId,
              source: 'cart',
              variants
            } as any
          }
        });

        if (oldPrice !== null && Number.isFinite(oldPrice) && minPrice > 0 && minPrice !== oldPrice) {
          const drop = calculatePriceDrop(oldPrice, minPrice);
          await this.checkAndNotify(updatedProduct.id, oldPrice, minPrice, drop, accountUserId);
        }

        // 推送前端更新通知
        frontendPush.notifyProductUpdate(product.id, {
          lastCheckAt: new Date().toISOString(),
          currentPrice: minPrice,
          title: first?.title || product.title,
        });

        updated++;

        const priceInfo = minOrig ? `￥${minPrice} (原价￥${minOrig})` : `￥${minPrice}`;
        console.log(`[CartScraper] 已更新: ${product.title} - ${priceInfo} variants=${variants.length}`);
      } catch (error) {
        console.error(`[CartScraper] 更新商品失败 productId=${product.id}:`, error);
        failed++;
      }
    }

    console.log(`[CartScraper] 更新完成: updated=${updated}, missing=${missing}, failed=${failed}`);
    return { updated, failed, missing };
  }

  private async ensureBaseProducts(accountId: string): Promise<void> {
    const baseCount = await prisma.product.count({
      where: {
        ownerAccountId: accountId,
        monitorMode: 'CART',
        skuId: CART_BASE_SKU_ID,
        isActive: true
      }
    });

    if (baseCount > 0) return;

    const legacy = await prisma.product.findMany({
      where: {
        ownerAccountId: accountId,
        monitorMode: 'CART',
        isActive: true,
        NOT: { skuId: CART_BASE_SKU_ID }
      },
      orderBy: { createdAt: 'asc' }
    });

    if (legacy.length === 0) return;

    const groups = new Map<string, typeof legacy>();
    for (const p of legacy) {
      const list = groups.get(p.taobaoId) ?? [];
      list.push(p);
      groups.set(p.taobaoId, list);
    }

    for (const [taobaoId, items] of groups.entries()) {
      const sample = items[0];
      const prices = items
        .map((x) => (x.currentPrice === null || x.currentPrice === undefined ? null : Number(x.currentPrice)))
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
      const minPrice = prices.length > 0 ? Math.min(...prices) : 0;

      const origs = items
        .map((x) => (x.originalPrice === null || x.originalPrice === undefined ? null : Number(x.originalPrice)))
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
      const minOrig = origs.length > 0 ? Math.min(...origs) : null;

      // Avoid depending on Prisma composite-unique "where field name" (can differ across histories).
      const existingBase = await prisma.product.findFirst({
        where: {
          taobaoId,
          skuId: CART_BASE_SKU_ID,
          ownerAccountId: accountId,
        },
        select: { id: true },
      });

      const base = existingBase
        ? await prisma.product.update({
            where: { id: existingBase.id },
            data: {
              monitorMode: 'CART',
              ownerAccountId: accountId,
              url: sample.url,
              title: sample.title ?? undefined,
              imageUrl: sample.imageUrl ?? undefined,
              currentPrice: minPrice,
              originalPrice: minOrig ?? undefined,
              lastCheckAt: new Date(),
              lastError: null,
              isActive: true,
            },
          })
        : await prisma.product.create({
            data: {
              taobaoId,
              skuId: CART_BASE_SKU_ID,
              monitorMode: 'CART',
              ownerAccountId: accountId,
              url: sample.url,
              title: sample.title,
              imageUrl: sample.imageUrl,
              currentPrice: minPrice,
              originalPrice: minOrig,
              isActive: true,
            },
          });

      const variants = items.map((x) => ({
        skuId: x.skuId ?? null,
        skuProperties: x.skuProperties ?? null,
        vidPath: '',
        selections: [],
        finalPrice: x.currentPrice === null || x.currentPrice === undefined ? null : Number(x.currentPrice),
        originalPrice: x.originalPrice === null || x.originalPrice === undefined ? null : Number(x.originalPrice),
        thumbnailUrl: x.imageUrl ?? null
      }));

      await prisma.priceSnapshot
        .create({
          data: {
            productId: base.id,
            finalPrice: minPrice,
            originalPrice: minOrig,
            accountId,
            rawData: { taobaoId, source: 'cart_migrated', variants } as any
          }
        })
        .catch(() => {});

      await prisma.product
        .updateMany({
          where: {
            ownerAccountId: accountId,
            monitorMode: 'CART',
            taobaoId,
            NOT: { skuId: CART_BASE_SKU_ID }
          },
          data: { isActive: false }
        })
        .catch(() => {});
    }
  }
}

export const cartScraper = new CartScraper();
