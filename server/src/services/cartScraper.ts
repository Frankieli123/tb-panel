import { Page } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { chromeLauncher } from './chromeLauncher.js';
import { HumanSimulator, randomDelay } from './humanSimulator.js';
import { notificationService } from './notification.js';
import { frontendPush } from './frontendPush.js';
import { calculatePriceDrop } from '../utils/helpers.js';
import { decryptCookies } from '../utils/helpers.js';

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
  error?: string;
}

export class CartScraper {
  private readonly keepOpen = /^(1|true)$/i.test(String(process.env.CART_SCRAPER_KEEP_OPEN ?? 'true'));
  private readonly sessionTtlMs = parseInt(process.env.CART_SCRAPER_SESSION_TTL_MS || '900000', 10); // 15min
  private sessions = new Map<
    string,
    { context: any; page: Page; human: HumanSimulator; cookieSig: string; lastUsedAt: number }
  >();
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

  private parseCookies(input?: string): any[] | null {
    if (!input) return null;

    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // continue
    }

    try {
      const decrypted = decryptCookies(input);
      const parsed = JSON.parse(decrypted);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private cookieSignature(input?: string): string {
    if (!input) return '';
    const s = String(input);
    return `${s.length}:${s.slice(0, 64)}`;
  }

  private async disposeSession(accountId: string, reason: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;
    this.sessions.delete(accountId);

    try {
      await session.page.close().catch(() => {});
    } catch {}
    try {
      await session.context.close().catch(() => {});
    } catch {}

    console.log(`[CartScraper] Session closed account=${accountId} reason=${reason}`);
  }

  private async closeIdleSessions(): Promise<void> {
    if (this.keepOpen) return;
    if (!Number.isFinite(this.sessionTtlMs) || this.sessionTtlMs <= 0) return;
    const now = Date.now();
    for (const [accountId, session] of this.sessions.entries()) {
      if (now - session.lastUsedAt > this.sessionTtlMs) {
        await this.disposeSession(accountId, 'idle_ttl');
      }
    }
  }

  private isFatalSessionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error ?? '');
    return (
      /Target closed|has been closed|Browser has been closed|Session closed|Connection closed/i.test(msg) ||
      /Navigation failed because page crashed/i.test(msg)
    );
  }

  private async checkAndNotify(
    productId: string,
    oldPrice: number,
    newPrice: number,
    drop: { amount: number; percent: number }
  ): Promise<void> {
    try {
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) return;

      const userConfigs = await (prisma as any).userNotificationConfig.findMany({
        where: {
          OR: [
            { emailEnabled: true },
            { wechatEnabled: true },
            { dingtalkEnabled: true },
            { feishuEnabled: true },
          ],
        },
      });

      if (!userConfigs.length) return;

      for (const cfg of userConfigs) {
        const threshold = parseFloat(cfg.triggerValue.toString());
        const shouldNotify =
          cfg.triggerType === 'AMOUNT' ? drop.amount >= threshold : drop.percent >= threshold;

        if (!shouldNotify) continue;

        await notificationService.sendPriceDropNotification({
          product,
          oldPrice,
          newPrice,
          drop,
          config: cfg,
        });
      }
    } catch (error) {
      console.error('[CartScraper] Notification error:', error);
    }
  }

  private async getOrCreateSession(accountId: string, cookies?: string): Promise<{
    context: any;
    page: Page;
    human: HumanSimulator;
    cookieSig: string;
    lastUsedAt: number;
  }> {
    const sig = this.cookieSignature(cookies);
    const existing = this.sessions.get(accountId);

    if (existing) {
      if (existing.page.isClosed()) {
        await this.disposeSession(accountId, 'page_closed');
      } else if (sig && existing.cookieSig && sig !== existing.cookieSig) {
        // cookies 发生变化：重建 session，避免混乱
        await this.disposeSession(accountId, 'cookies_changed');
      } else {
        existing.lastUsedAt = Date.now();
        return existing;
      }
    }

    const realChrome = await chromeLauncher.launch();
    console.log('[CartScraper] Using real Chrome browser via CDP');

    // 使用用户真实 Chrome 的浏览器指纹，不覆盖 UserAgent
    const context = await realChrome.newContext({
      // 不设置 userAgent，保持用户 Chrome 的真实指纹
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    await context
      .addInitScript(`globalThis.__name = (fn, _name) => fn; var __name = globalThis.__name;`)
      .catch(() => {});

    const cookieArray = this.parseCookies(cookies);
    if (cookieArray && cookieArray.length > 0) {
      await context.addCookies(cookieArray).catch((e: any) => {
        console.warn('[CartScraper] Failed to inject cookies:', e);
      });
    }

    const page = await context.newPage();
    if (!page) throw new Error('Failed to create page');
    const human = new HumanSimulator(page);

    // 首次建立时就打开购物车页；后续轮询将用 reload 刷新（更像真人停留在页面上）
    await human.navigateAsHuman('https://cart.taobao.com/cart.htm');
    await page.waitForTimeout(randomDelay(1200, 2200));

    const session = { context, page, human, cookieSig: sig, lastUsedAt: Date.now() };
    this.sessions.set(accountId, session);
    return session;
  }

  private async makeCartPageMoreHuman(page: Page, human: HumanSimulator): Promise<void> {
    // 轻微鼠标/滚动，让行为更接近真人阅读购物车列表
    await human.occasionalWander().catch(() => {});
    if (Math.random() < 0.6) {
      await human.randomScroll({ distance: randomDelay(120, 360) }).catch(() => {});
      if (Math.random() < 0.35) {
        await page.mouse.wheel(0, -randomDelay(80, 220)).catch(() => {});
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
    await this.makeCartPageMoreHuman(session.page, session.human);
    await session.page.waitForTimeout(randomDelay(600, 1200));
  }

  async scrapeCart(accountId: string, cookies?: string): Promise<CartScrapeResult> {
    console.log(`[CartScraper] Start scraping cart for account=${accountId}`);

    return this.runExclusive(async () => {
      let lastErr: any = null;

      // keepOpen 模式下允许一次自愈重试（用户可能手动关掉窗口/页面）
      const maxAttempts = this.keepOpen ? 2 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const session = await this.getOrCreateSession(accountId, cookies);
          await this.refreshCartPage(session);

          const cartData = await this.extractCartData(session.page);
          console.log(`[CartScraper] Found ${cartData.products.length} products in cart`);

          return {
            success: true,
            products: cartData.products,
            total: cartData.products.length,
          };
        } catch (error: any) {
          lastErr = error;
          console.error(`[CartScraper] Error (attempt ${attempt}/${maxAttempts}):`, error);

          const fatal = this.isFatalSessionError(error);
          if (fatal) {
            await this.disposeSession(accountId, 'fatal_error');
            continue;
          }

          // 非致命错误：keepOpen 模式下保留 session（下次轮询继续用），否则释放
          if (!this.keepOpen) {
            await this.disposeSession(accountId, 'scrape_error');
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

  private async extractCartData(page: Page): Promise<{ products: CartProduct[] }> {
    const products = await page.evaluate(() => {
      const items: any[] = [];

      // 基于真实DOM结构提取数据（2024淘宝购物车页面结构）
      // 购物车商品容器：.trade-cart-item-info
      const cartItems = Array.from(document.querySelectorAll('.trade-cart-item-info'));

      cartItems.forEach((item) => {
        // 标题：a.title--dsuLK9IN
        const titleEl = item.querySelector('a.title--dsuLK9IN');
        const title = titleEl?.textContent?.trim() || '';

        // 图片：img.image--MC0kGGgi
        const imageEl = item.querySelector('img.image--MC0kGGgi');
        const imageSrc = imageEl?.getAttribute('src') || null;
        // 补全图片协议
        const imageUrl = imageSrc ? (imageSrc.startsWith('//') ? 'https:' + imageSrc : imageSrc) : null;

        // 价格容器：.trade-cart-item-price
        const priceContainer = item.querySelector('.trade-cart-item-price');

        // 获取所有价格容器（通常有2个：券后价和券前价）
        const priceContainers = priceContainer ? Array.from(priceContainer.querySelectorAll('.trade-price-container')) : [];

        let finalPrice = 0;
        let originalPrice: number | null = null;

        if (priceContainers.length > 0) {
          // 第一个价格容器：券后价
          const firstContainer = priceContainers[0];
          const priceInteger1 = firstContainer?.querySelector('.trade-price-integer')?.textContent?.trim() || '0';
          const priceDecimal1 = firstContainer?.querySelector('.trade-price-decimal')?.textContent?.trim() || '0';
          finalPrice = parseFloat(`${priceInteger1}.${priceDecimal1}`);

          // 第二个价格容器：券前价（如果存在）
          if (priceContainers.length > 1) {
            const secondContainer = priceContainers[1];
            const priceInteger2 = secondContainer?.querySelector('.trade-price-integer')?.textContent?.trim() || '0';
            const priceDecimal2 = secondContainer?.querySelector('.trade-price-decimal')?.textContent?.trim() || '0';
            originalPrice = parseFloat(`${priceInteger2}.${priceDecimal2}`);
          }
        }

        // SKU属性：.trade-cart-item-sku-old 下的所有 .label--T4deixnF
        const skuEl = item.querySelector('.trade-cart-item-sku-old');
        const skuLabels = skuEl ? Array.from(skuEl.querySelectorAll('.label--T4deixnF')) : [];
        const skuProperties = skuLabels.map(label => label.textContent?.trim() || '').join(' ');

        // 从链接中提取ID：<a href="...?id=875765952236&skuId=5880572559451">
        const linkEl = item.querySelector('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');
        const href = linkEl?.getAttribute('href') || '';

        const taobaoIdMatch = href.match(/[?&]id=(\d+)/);
        const skuIdMatch = href.match(/[?&]skuId=(\d+)/);

        const taobaoId = taobaoIdMatch ? taobaoIdMatch[1] : '';
        const skuId = skuIdMatch ? skuIdMatch[1] : '';

        if (!taobaoId) {
          return; // 跳过无效项
        }

        items.push({
          taobaoId,
          skuId,
          skuProperties,
          title,
          imageUrl,
          finalPrice,
          originalPrice,
          quantity: 1,
          cartItemId: `${taobaoId}_${skuId}`
        });
      });

      return items;
    });

    return { products };
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
    console.log(`[CartScraper] Updating prices from cart for account=${accountId}`);

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
      console.log(`[CartScraper] No monitored products for account=${accountId}`);
      return { updated: 0, failed: 0, missing: 0 };
    }

    console.log(`[CartScraper] Found ${monitoredProducts.length} monitored products`);

    // 2. 从购物车抓取所有商品（或使用外部 Agent 已抓取的数据）
    const cartResult = options?.cartResult ?? (await this.scrapeCart(accountId, cookies));

    if (!cartResult.success) {
      console.error(`[CartScraper] Failed to scrape cart: ${cartResult.error}`);
      return { updated: 0, failed: monitoredProducts.length, missing: 0 };
    }

    console.log(`[CartScraper] Found ${cartResult.products.length} products in cart`);

    // 3. 建立购物车商品索引 (taobaoId -> CartProduct[])
    const cartByTaobaoId = new Map<string, CartProduct[]>();
    for (const cartProduct of cartResult.products) {
      const list = cartByTaobaoId.get(cartProduct.taobaoId) ?? [];
      list.push(cartProduct);
      cartByTaobaoId.set(cartProduct.taobaoId, list);
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

        const cartItems = cartByTaobaoId.get(product.taobaoId) ?? [];

        if (cartItems.length === 0) {
          // 购物车中没有该商品，标记为缺失
          missing++;
          console.log(`[CartScraper] Missing in cart: ${product.title} (${product.taobaoId})`);

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

        if (oldPrice !== null && Number.isFinite(oldPrice) && minPrice > 0 && minPrice < oldPrice) {
          const drop = calculatePriceDrop(oldPrice, minPrice);
          await this.checkAndNotify(updatedProduct.id, oldPrice, minPrice, drop);
        }

        // 推送前端更新通知
        frontendPush.notifyProductUpdate(product.id, {
          lastCheckAt: new Date().toISOString(),
          currentPrice: minPrice,
          title: first?.title || product.title,
        });

        updated++;

        const priceInfo = minOrig ? `￥${minPrice} (原价￥${minOrig})` : `￥${minPrice}`;
        console.log(`[CartScraper] Updated: ${product.title} - ${priceInfo} variants=${variants.length}`);
      } catch (error) {
        console.error(`[CartScraper] Failed to update product ${product.id}:`, error);
        failed++;
      }
    }

    console.log(`[CartScraper] Update complete: updated=${updated}, missing=${missing}, failed=${failed}`);
    await this.closeIdleSessions().catch(() => {});
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
