import { Page, BrowserContext, Browser } from 'playwright';
import { SkuParser, SkuCombination } from './skuParser.js';
import { HumanSimulator, randomDelay, randomRange } from './humanSimulator.js';
import { sharedBrowserManager } from './sharedBrowserManager.js';
import fs from 'fs/promises';
import path from 'path';

type SkuSelection = {
  propId: string;
  propName: string;
  valueId: string;
  valueName: string;
};

function normalizeSkuProperties(input: string): string {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .replace(/[;；]+/g, ';')
    .replace(/\s*;\s*/g, ';')
    .trim();
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
    console.log('[AutoCart] Browser session kept open for reuse');
  }

  private async ensureBrowser(accountId: string, cookies?: string): Promise<void> {
    // 使用共享浏览器管理器，让 autoCartAdder 和 cartScraper 共享同一个浏览器
    const session = await sharedBrowserManager.getOrCreateSession(accountId, cookies);
    
    this.context = session.context;
    this.page = session.page;
    this.humanSimulator = session.human;
    this.skuParser = new SkuParser(this.page);
    this.currentAccountId = accountId;
    
    console.log('[AutoCart] Using shared browser session');
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

  private async collectCartSkuPropertiesForTaobaoId(taobaoId: string): Promise<Set<string>> {
    const seen = new Set<string>();
    let lastSize = 0;
    let stableRounds = 0;

    for (let round = 0; round < 8; round++) {
      const rawList = await this.page
        .evaluate((id) => {
          const items = Array.from(document.querySelectorAll('.trade-cart-item-info'));
          const out: string[] = [];

          for (const item of items) {
            const linkEl = item.querySelector('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');
            const href = linkEl?.getAttribute('href') || '';
            const taobaoIdMatch = href.match(/[?&]id=(\d+)/);
            const tid = taobaoIdMatch ? taobaoIdMatch[1] : '';
            if (!tid || String(tid) !== String(id)) continue;

            const skuEl = item.querySelector('.trade-cart-item-sku-old');
            const skuLabels = skuEl ? Array.from(skuEl.querySelectorAll('.label--T4deixnF')) : [];
            const skuProperties = skuLabels.map((label) => label.textContent?.trim() || '').join(' ');
            if (skuProperties) out.push(skuProperties);
          }

          return out;
        }, taobaoId)
        .catch(() => [] as string[]);

      for (const raw of rawList) {
        const norm = normalizeSkuProperties(raw);
        if (norm) seen.add(norm);
      }

      if (seen.size === lastSize) {
        stableRounds++;
      } else {
        stableRounds = 0;
        lastSize = seen.size;
      }

      if (stableRounds >= 2) break;

      // 轻量滚动让更多购物车条目进入 DOM（更像人工翻看）
      await this.humanSimulator.randomScroll({ distance: randomRange(320, 760) }).catch(() => {});
      await this.humanSimulator.sleep(randomDelay(650, 1200));
      await this.closeFeatureTips().catch(() => {});
      await this.waitForOverlaysCleared().catch(() => {});
    }

    return seen;
  }

  private async openProductFromCartOrNavigate(
    taobaoId: string
  ): Promise<{ cartUrl: string; usedPopup: boolean; usedSameTab: boolean; cartPage: Page }> {
    const cartPage = this.page;
    const cartUrl = cartPage.url();

    // 在新标签页打开商品详情页，保持购物车页面不关闭
    const url = `https://item.taobao.com/item.htm?id=${taobaoId}`;
    console.log(`[AutoCart] Opening product page in new tab: ${url}`);
    
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

  private async assertNotAuthPage(stage: string): Promise<void> {
    const url = this.page.url();
    if (this.isAuthOrChallengeUrl(url)) {
      throw new Error(`需要登录/验证码（${stage}）：${url}`);
    }

    const title = await this.page.title().catch(() => '');
    if (/登录|Login|安全验证|验证码/.test(title) && /taobao|tmall|alibaba/i.test(url)) {
      throw new Error(`需要登录/验证码（${stage}）：${url}`);
    }

    const bodyText = await this.page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    if (/(扫码登录|密码登录|短信登录|安全验证|验证码|滑块|请先登录)/.test(bodyText)) {
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
    options?: { headless?: boolean; onProgress?: ProgressCallback; existingCartSkus?: Map<string, Set<string>> }
  ): Promise<AddAllSkusResult> {
    return this.runExclusive(async () => {
      const startTime = Date.now();
      console.log(`[AutoCart] Start taobaoId=${taobaoId} accountId=${accountId}`);
      console.log(`[AutoCart] Mode: ${options?.headless === false ? 'Human-visible' : 'Headless'}`);

      try {
        // 复用或创建浏览器实例
        await this.ensureBrowser(accountId, cookies);

        // 阶段1：打开购物车预检查已存在的SKU
        // 如果批量模式已经预先抓取过购物车，则直接使用传入的数据
        let existedSkuProps: Set<string>;
        if (options?.existingCartSkus?.has(taobaoId)) {
          existedSkuProps = options.existingCartSkus.get(taobaoId)!;
          console.log(`[AutoCart] Using pre-fetched cart data: taobaoId=${taobaoId} existedSkus=${existedSkuProps.size}`);
          if (options?.onProgress) {
            options.onProgress(
              { total: 0, current: 0, success: 0, failed: 0 },
              `【阶段1/5】使用预抓取的购物车数据，已存在 ${existedSkuProps.size} 个SKU`
            );
          }
          // 直接跳到商品页，不需要先打开购物车
        } else {
          if (options?.onProgress) {
            options.onProgress(
              { total: 0, current: 0, success: 0, failed: 0 },
              '【阶段1/5】打开购物车，预检查已存在的SKU...'
            );
          }
          await this.navigateToCartPage();
          existedSkuProps = await this.collectCartSkuPropertiesForTaobaoId(taobaoId);
          console.log(`[AutoCart] Cart precheck: taobaoId=${taobaoId} existedSkus=${existedSkuProps.size}`);
          if (options?.onProgress) {
            options.onProgress(
              { total: 0, current: 0, success: 0, failed: 0 },
              `【阶段1/5】购物车预检查完成，已存在 ${existedSkuProps.size} 个SKU`
            );
          }
        }

        // 阶段2：打开商品详情页
        if (options?.onProgress) {
          options.onProgress(
            { total: 0, current: 0, success: 0, failed: 0 },
            '【阶段2/5】打开商品详情页...'
          );
        }
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
        const skuTree = await this.skuParser.parseSkuTree(taobaoId);
        console.log(`[AutoCart] Found ${skuTree.combinations.length} SKU combinations`);

        const availableSkus = skuTree.combinations.filter((sku) => sku.stock > 0);
        console.log(`[AutoCart] Available SKUs: ${availableSkus.length}`);

        const existedNorm = new Set(Array.from(existedSkuProps.values()).map((x) => normalizeSkuProperties(x)));
        const skippedCount = availableSkus.filter(sku => {
          const norm = normalizeSkuProperties(sku.properties);
          return norm && existedNorm.has(norm);
        }).length;
        const toAddCount = availableSkus.length - skippedCount;
        
        const shuffled = this.shuffleArray(availableSkus);

        // 阶段4：开始加购
        if (options?.onProgress) {
          options.onProgress(
            { total: shuffled.length, current: 0, success: 0, failed: 0 },
            `【阶段4/5】开始加购：总计 ${shuffled.length} 个SKU，已存在 ${skippedCount} 个将跳过，需新加购 ${toAddCount} 个`
          );
        }

        const results: SkuAddResult[] = [];

        for (let i = 0; i < shuffled.length; i++) {
          const sku = shuffled[i];
          console.log(`[AutoCart] Processing SKU ${i + 1}/${shuffled.length}: ${sku.properties}`);

          try {
            const norm = normalizeSkuProperties(sku.properties);
            let result: SkuAddResult;

            if (norm && existedNorm.has(norm)) {
              console.log(`[AutoCart] SKU already in cart, skip: ${sku.properties}`);
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
            } else {
              result = await this.addSingleSkuAsHuman(sku, taobaoId);
              if (norm) existedNorm.add(norm);
            }

            results.push(result);

            // 实时更新进度
            const successCount = results.filter((r) => r.success).length;
            const failedCount = results.filter((r) => !r.success).length;
            if (options?.onProgress) {
              options.onProgress(
                { total: shuffled.length, current: i + 1, success: successCount, failed: failedCount },
                `已处理 ${i + 1}/${shuffled.length}：${result.success ? '成功' : '失败'} - ${sku.properties}`
              );
            }

            if (i < shuffled.length - 1) {
              // SKU 间隔：保持随机但适度加快；偶尔更长停顿更“像人”
              let delay = randomDelay(900, 2200);
              if (Math.random() < 0.08) delay += randomDelay(2000, 5000);
              console.log(`[AutoCart] Waiting ${delay}ms before next SKU...`);
              await this.humanSimulator.sleep(delay);
            }
          } catch (error: any) {
            console.error(`[AutoCart] Failed SKU: ${sku.skuId}`, error);
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
            const successCount = results.filter((r) => r.success).length;
            const failedCount = results.filter((r) => !r.success).length;
            if (options?.onProgress) {
              options.onProgress(
                { total: shuffled.length, current: i + 1, success: successCount, failed: failedCount },
                `已处理 ${i + 1}/${shuffled.length}：失败 - ${error.message}`
              );
            }
          }
        }

        const successCount = results.filter((r) => r.success).length;
        const duration = Date.now() - startTime;

        console.log(`[AutoCart] Complete: ${successCount}/${shuffled.length} success, duration=${duration}ms`);

        // 阶段5：关闭商品详情页，切回购物车页面刷新获取价格
        if (options?.onProgress) {
          options.onProgress(
            { total: shuffled.length, current: shuffled.length, success: successCount, failed: shuffled.length - successCount },
            '【阶段5/5】返回购物车页面刷新获取价格...'
          );
        }
        
        // 关闭商品详情页（当前页面）
        await this.page.close().catch(() => {});
        
        // 切回购物车页面
        this.page = openInfo.cartPage;
        this.humanSimulator = new HumanSimulator(this.page);
        this.skuParser = new SkuParser(this.page);
        
        // 刷新购物车页面获取最新价格
        console.log('[AutoCart] Refreshing cart page to get latest prices...');
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await this.humanSimulator.sleep(randomDelay(1000, 2000));
        await this.closeFeatureTips().catch(() => {});
        await this.waitForOverlaysCleared().catch(() => {});

        // 直接在当前页面抓取购物车数据
        console.log('[AutoCart] Extracting cart data from current page...');
        const cartProducts = await this.extractCartDataFromCurrentPage(taobaoId);
        console.log(`[AutoCart] Extracted ${cartProducts.length} products for taobaoId=${taobaoId}`);

        return {
          taobaoId,
          totalSkus: shuffled.length,
          successCount,
          failedCount: shuffled.length - successCount,
          results,
          duration,
          cartProducts, // 直接返回购物车数据，避免再次调用 scrapeCart
        };
      } finally {
        // 不关闭页面和 context，保持购物车页面打开供用户查看
        // 注意：浏览器实例会一直运行，直到用户手动关闭或下次任务复用
        console.log('[AutoCart] Task complete, keeping cart page open for user');
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
          `[AutoCart] addSingleSku attempt ${attempt} failed skuId=${sku.skuId}: ${error?.message ?? String(error)}`
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
    console.log(`[AutoCart] Adding SKU (attempt ${attempt}): ${sku.properties}`);

    await this.assertNotAuthPage('开始加购');

    try {
      await this.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await this.humanSimulator.sleep(randomDelay(250, 600));
    } catch (e) {
      console.warn('[AutoCart] Failed to scroll to top:', e);
    }

    await this.closeAddCartModal();
    await this.closeFeatureTips();
    await this.waitForOverlaysCleared();

    for (let i = 0; i < sku.selections.length; i++) {
      const selection = sku.selections[i] as SkuSelection;
      console.log(
        `[AutoCart] Selecting layer ${i + 1}/${sku.selections.length}: propId=${selection.propId}, valueId=${selection.valueId}`
      );

      await this.selectSkuPropertyAsHuman(selection);
      console.log(`[AutoCart] Layer ${i + 1} selected successfully`);

      await this.humanSimulator.sleep(randomDelay(250, 600));
      if (i < sku.selections.length - 1) {
        await this.waitForPriceStable();
      }
    }

    if (Math.random() < 0.15) {
      console.log('[AutoCart] Random scroll...');
      await this.humanSimulator.randomScroll({ distance: randomRange(200, 500) });
    }

    console.log('[AutoCart] Occasional wander check...');
    await this.humanSimulator.occasionalWander();
    console.log('[AutoCart] Looking for add-cart button...');

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
        console.log(`[AutoCart] Found add-cart button with selector: ${selector}`);
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

    console.log(`[AutoCart] SKU added successfully: ${sku.skuId}`);

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
          `[AutoCart] SKU selection may not be applied: ${selection.propName}=${selection.valueName} (valueId=${selection.valueId})`
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
      console.log('[AutoCart] Closing add-to-cart modal...');

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
              console.log(`[AutoCart] Found mini popup: ${selector}`);

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
                    console.log('[AutoCart] Could not scroll to mini popup close button');
                  }

                  console.log('[AutoCart] Clicking mini popup close button');
                  await closeBtn.click({ timeout: 3000 }).catch(() => {});
                  await this.humanSimulator.sleep(randomDelay(250, 600));
                  console.log('[AutoCart] Mini popup closed successfully');
                  return;
                }
              }

              // 等待弹窗自动消失（不再点击外部区域，避免误点击其他商品）
              console.log('[AutoCart] Waiting for mini popup auto-dismiss...');
              await this.humanSimulator.sleep(randomDelay(1500, 2500));

              // 检查是否已经消失
              const stillVisible = await miniPopup.isVisible().catch(() => false);
              if (!stillVisible) {
                console.log('[AutoCart] Mini popup auto-dismissed');
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
                console.log('[AutoCart] Could not scroll to close button');
              }

              console.log(`[AutoCart] Found close button: ${selector}`);
              await closeBtn.click({ timeout: 3000 }).catch(() => {});
              await this.humanSimulator.sleep(randomDelay(250, 600));
              console.log('[AutoCart] Modal closed successfully');
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
          console.log('[AutoCart] Clicking mask to close modal...');
          await mask.click({ timeout: 2000 }).catch(() => {});
          await this.humanSimulator.sleep(randomDelay(200, 450));

          // 检查是否成功关闭
          const stillVisible = await mask.isVisible().catch(() => false);
          if (!stillVisible) {
            console.log('[AutoCart] Modal closed by mask click');
            return;
          }
        }
      }

      // 策略4：按 ESC 键
      console.log('[AutoCart] Trying ESC key to close modal...');
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.humanSimulator.sleep(randomDelay(200, 350));

      console.log('[AutoCart] Attempted to close modal');
    } catch (error) {
      console.warn('[AutoCart] Failed to close modal:', error);
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
      console.log(`[AutoCart] Feature tip detection: maskVisible=${maskVisible}, bigImageTipVisible=${bigImageTipVisible}, quickVisible=${quickVisible}`);

      // 没有任何迹象时直接返回；每 15s 允许做一次深度扫描兜底（防止偶发样式变体漏检）
      if (!maskVisible && !quickVisible && !bigImageTipVisible && now - this.lastTipDeepScanAt < 15_000) {
        console.log('[AutoCart] No feature tip detected, skipping...');
        return;
      }

      this.lastTipDeepScanAt = now;
      console.log('[AutoCart] Checking for feature tip popups...');

      // 优先处理"新增大图查看功能"弹窗
      if (bigImageTipVisible) {
        console.log('[AutoCart] Detected "新增大图查看功能" popup, attempting to close...');
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
          console.log(`[AutoCart] Trying selector "${selector}": visible=${visible}`);
          if (visible) {
            try {
              const box = await closeBtn.boundingBox().catch(() => null);
              console.log(`[AutoCart] Button bounding box:`, box);
              await closeBtn.scrollIntoViewIfNeeded().catch(() => {});
              await this.humanSimulator.sleep(randomDelay(100, 200));
              await closeBtn.click({ timeout: 2000, force: true });
              console.log('[AutoCart] Closed "新增大图查看功能" popup successfully');
              await this.humanSimulator.sleep(randomDelay(200, 400));
              await this.waitForOverlaysCleared(2000);
              closed = true;
              break;
            } catch (e) {
              console.warn('[AutoCart] Failed to close via', selector, e);
            }
          }
        }
        if (!closed) {
          console.log('[AutoCart] Could not close popup with selectors, trying page.evaluate...');
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
            console.log('[AutoCart] Closed popup via page.evaluate');
            await this.humanSimulator.sleep(randomDelay(200, 400));
          } else {
            console.log('[AutoCart] Failed to find "知道了" button via page.evaluate');
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
            console.log(`[AutoCart] Closed feature tip via ${label} (index ${idx})`);
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
              console.log('[AutoCart] Attempting to close mask layer...');
              await mask.click({ timeout: 1000 }).catch(() => {});
              await this.humanSimulator.sleep(250);
              break;
            }
          }

          // 最后兜底：只有在确实有遮罩/弹层迹象时才按 ESC，避免无意义地反复按键
          console.log('[AutoCart] Attempting to close tips with ESC key...');
          const t = Date.now();
          if (t - this.lastTipEscapeAt > 900) {
            this.lastTipEscapeAt = t;
            await this.page.keyboard.press('Escape').catch(() => {});
            await this.humanSimulator.sleep(randomDelay(120, 240));
          }
        }
      }

      console.log('[AutoCart] Feature tips check complete');
    } catch (error) {
      console.warn('[AutoCart] Failed to close feature tips:', error);
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
      console.error('[AutoCart] Failed to extract cart data:', error?.message);
      return [];
    }
  }
}

export const autoCartAdder = new AutoCartAdder();
