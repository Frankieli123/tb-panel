import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { config } from '../config/index.js';
import { decryptCookies, sleep } from '../utils/helpers.js';
import path from 'path';
import fs from 'fs/promises';

// iPhone 12 Pro 设备配置
const MOBILE_DEVICE = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const DESKTOP_DEVICE = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
};

// stealth.min.js 内容会在运行时加载
let stealthScript: string | null = null;

async function loadStealthScript(): Promise<string> {
  if (stealthScript) return stealthScript;

  const stealthPath = path.join(process.cwd(), 'stealth.min.js');
  try {
    stealthScript = await fs.readFile(stealthPath, 'utf-8');
  } catch {
    // 如果本地没有，使用内联的基础反检测脚本
    stealthScript = `
      // 基础反检测
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      window.chrome = { runtime: {} };
    `;
  }
  return stealthScript;
}

export interface ScrapedPrice {
  finalPrice: number | null;
  originalPrice: number | null;
  title: string | null;
  imageUrl: string | null;
  couponInfo: string | null;
  promotionInfo: string | null;
  variants?: ScrapedSkuVariant[];
  rawHtml?: string;
}

export interface ScrapedSkuVariant {
  skuKey: string;
  skuId: string | null;
  skuProperties: string | null;
  vidPath: string;
  selections: Array<{ label: string; vid: string; value: string }>;
  finalPrice: number | null;
  originalPrice: number | null;
  thumbnailUrl: string | null;
}

export interface ScrapeResult {
  success: boolean;
  data?: ScrapedPrice;
  error?: string;
  needCaptcha?: boolean;
  needLogin?: boolean;
}

export class TaobaoScraper {
  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();

  async init(): Promise<void> {
    if (this.browser) return;

    // 确保浏览器数据目录存在
    await fs.mkdir(config.scraper.userDataDir, { recursive: true });

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });

    console.log('[Scraper] Browser initialized');
  }

  async getContext(accountId: string, cookies?: string): Promise<BrowserContext> {
    return this.getContextWithMode(accountId, 'desktop', cookies);
  }

  private async getContextWithMode(
    accountId: string,
    mode: 'mobile' | 'desktop',
    cookies?: string
  ): Promise<BrowserContext> {
    if (!this.browser) {
      await this.init();
    }

    const contextKey = `${accountId}:${mode}`;
    let context = this.contexts.get(contextKey);
    if (context) {
      await context
        .addInitScript(`globalThis.__name = (fn, _name) => fn; var __name = globalThis.__name;`)
        .catch(() => {});
      return context;
    }

    const device = mode === 'mobile' ? MOBILE_DEVICE : DESKTOP_DEVICE;

    context = await this.browser!.newContext({ ...device, storageState: undefined });

    const stealth = await loadStealthScript();
    await context.addInitScript(stealth);
    await context.addInitScript(`globalThis.__name = (fn, _name) => fn; var __name = globalThis.__name;`);

    if (cookies) {
      try {
        const cookieList = JSON.parse(decryptCookies(cookies));
        await context.addCookies(cookieList);
      } catch (e) {
        console.error(`[Scraper] Failed to inject cookies for account ${accountId}:`, e);
      }
    }

    this.contexts.set(contextKey, context);
    return context;
  }

  private async saveDebugArtifacts(
    page: Page,
    accountId: string,
    taobaoId: string,
    tag: string
  ): Promise<{
    dir: string;
    prefix: string;
    screenshotPath: string;
    htmlPath: string;
    metaPath: string;
  } | null> {
    try {
      const dir = path.join(config.scraper.userDataDir, '_debug');
      await fs.mkdir(dir, { recursive: true });

      const ts = new Date();
      const stamp = ts.toISOString().replace(/[:.]/g, '-');
      const prefix = `${stamp}_${accountId}_${taobaoId}_${tag}`;

      const screenshotPath = path.join(dir, `${prefix}.png`);
      const htmlPath = path.join(dir, `${prefix}.html`);
      const metaPath = path.join(dir, `${prefix}.json`);

      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      const normalizedHtml = html
        .replace(/\b(src|href)=(['"])\/\//gi, '$1=$2https://')
        .replace(/url\((['"])\/\//gi, 'url($1https://')
        .replace(/url\(\/\//gi, 'url(https://');
      await fs.writeFile(htmlPath, normalizedHtml, 'utf-8').catch(() => {});
      await fs.writeFile(
        metaPath,
        JSON.stringify(
          {
            url: page.url(),
            title: await page.title().catch(() => ''),
            capturedAt: ts.toISOString(),
          },
          null,
          2
        ),
        'utf-8'
      ).catch(() => {});

      return {
        dir,
        prefix,
        screenshotPath,
        htmlPath,
        metaPath,
      };
    } catch {
      return null;
    }
  }

  private async waitForSkuPanel(page: Page): Promise<void> {
    await page
      .locator(
        'div[id^="SkuPanel_"] div[id*="SkuPanelBody"] div[class*="valueItem--"][data-vid][data-disabled], div[id^="SkuPanel_"] div[id*="SkuPanelBody"] [data-vid][data-disabled], div[id^="SkuPanel_"] [class*="skuItem--"] div[class*="valueItem--"][data-vid][data-disabled], div[id^="SkuPanel_"] [class*="skuItem--"] [data-vid][data-disabled], #skuOptionsArea div[class*="valueItem--"][data-vid][data-disabled], #skuOptionsArea [data-vid][data-disabled], [id*="skuOptionsArea"] div[class*="valueItem--"][data-vid][data-disabled], [id*="skuOptionsArea"] [data-vid][data-disabled]'
      )
      .first()
      .waitFor({ state: 'attached', timeout: 4500 })
      .catch(() => {});
  }

  async scrapeProduct(
    accountId: string,
    taobaoId: string,
    cookies?: string
  ): Promise<ScrapeResult> {
    const pcUrl = `https://item.taobao.com/item.htm?id=${taobaoId}`;

    return this.scrapeUrl(accountId, taobaoId, pcUrl, 'desktop', cookies);
  }

  private async scrapeUrl(
    accountId: string,
    taobaoId: string,
    url: string,
    mode: 'mobile' | 'desktop',
    cookies?: string
  ): Promise<ScrapeResult> {
    let page: Page | null = null;
    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    const logTimings = (status: string) => {
      const totalMs = Date.now() - startedAt;
      const parts = Object.entries(timings)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(
        `[Scraper] [${mode}] Timings account=${accountId} taobaoId=${taobaoId} status=${status} totalMs=${totalMs} ${parts}`
      );
    };
    try {
      const context = await this.getContextWithMode(accountId, mode, cookies);
      page = await context.newPage();

      // 兜底：某些构建链路会把 evaluate 回调包一层 __name(...)，确保页面里一定存在该全局变量
      await page.addInitScript(`globalThis.__name = (fn, _name) => fn; var __name = globalThis.__name;`).catch(() => {});
      await page
        .evaluate('var __name = (fn, _name) => fn; globalThis.__name = __name;')
        .catch(() => {});

      console.log(
        `[Scraper] [${mode}] Start account=${accountId} taobaoId=${taobaoId} url=${url}`
      );

      const navStartAt = Date.now();
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.scraper.pageTimeoutMs,
      });
      const navMs = Date.now() - navStartAt;
      timings.navMs = navMs;

      console.log(
        `[Scraper] [${mode}] Navigated status=${response?.status() ?? 'n/a'} responseUrl=${response?.url() ?? 'n/a'} finalUrl=${page.url()} navMs=${navMs}`
      );

      const sleepStartAt = Date.now();
      await sleep(1000);
      timings.sleepMs = Date.now() - sleepStartAt;

      const needLoginStartAt = Date.now();
      const needLogin = await this.checkNeedLogin(page);
      timings.checkNeedLoginMs = Date.now() - needLoginStartAt;
      if (needLogin) {
        const artifactsStartAt = Date.now();
        const artifacts = await this.saveDebugArtifacts(page, accountId, taobaoId, `${mode}_need_login`);
        timings.saveArtifactsMs = Date.now() - artifactsStartAt;
        console.warn(
          `[Scraper] [${mode}] NeedLogin account=${accountId} taobaoId=${taobaoId} finalUrl=${page.url()} ms=${Date.now() - startedAt} artifacts=${artifacts?.prefix ?? 'n/a'}`
        );
        logTimings('needLogin');
        return { success: false, needLogin: true, error: 'Need login' };
      }

      const needCaptchaStartAt = Date.now();
      const needCaptcha = await this.checkCaptcha(page);
      timings.checkCaptchaMs = Date.now() - needCaptchaStartAt;
      if (needCaptcha) {
        const artifactsStartAt = Date.now();
        const artifacts = await this.saveDebugArtifacts(page, accountId, taobaoId, `${mode}_captcha`);
        timings.saveArtifactsMs = Date.now() - artifactsStartAt;
        console.warn(
          `[Scraper] [${mode}] CaptchaDetected account=${accountId} taobaoId=${taobaoId} finalUrl=${page.url()} ms=${Date.now() - startedAt} artifacts=${artifacts?.prefix ?? 'n/a'}`
        );
        logTimings('captcha');
        return { success: false, needCaptcha: true, error: 'Captcha detected' };
      }

      const accessDeniedStartAt = Date.now();
      const accessDenied = await this.checkAccessDenied(page);
      timings.checkAccessDeniedMs = Date.now() - accessDeniedStartAt;
      if (accessDenied) {
        const artifactsStartAt = Date.now();
        const artifacts = await this.saveDebugArtifacts(page, accountId, taobaoId, `${mode}_access_denied`);
        timings.saveArtifactsMs = Date.now() - artifactsStartAt;
        console.warn(
          `[Scraper] [${mode}] AccessDenied account=${accountId} taobaoId=${taobaoId} finalUrl=${page.url()} ms=${Date.now() - startedAt} artifacts=${artifacts?.prefix ?? 'n/a'}`
        );
        logTimings('accessDenied');
        return { success: false, needCaptcha: true, error: 'Access denied' };
      }

      const waitPriceStartAt = Date.now();
      await this.waitForPriceElement(page);
      timings.waitForPriceMs = Date.now() - waitPriceStartAt;

      const waitSkuStartAt = Date.now();
      await this.waitForSkuPanel(page);
      timings.waitForSkuMs = Date.now() - waitSkuStartAt;

      const extractStartAt = Date.now();
      const data = await this.extractPriceInfo(page);
      timings.extractMs = Date.now() - extractStartAt;

      if (data.finalPrice === null && data.originalPrice === null) {
        const artifactsStartAt = Date.now();
        const artifacts = await this.saveDebugArtifacts(page, accountId, taobaoId, `${mode}_no_price`);
        timings.saveArtifactsMs = Date.now() - artifactsStartAt;
        console.warn(
          `[Scraper] [${mode}] NoPriceExtracted account=${accountId} taobaoId=${taobaoId} finalUrl=${page.url()} ms=${Date.now() - startedAt} artifacts=${artifacts?.prefix ?? 'n/a'}`
        );
        logTimings('noPrice');
        return { success: false, error: 'Price not found' };
      }

      if (!data.variants || data.variants.length === 0) {
        const skuDiag = await page
          .evaluate(() => {
            const doc = (globalThis as any).document as any;
            const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
            const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
            const scope = panelBody || panel || doc;
            const skuItems = Array.from(scope?.querySelectorAll?.('[class*="skuItem--"]') ?? []);
            const vidNodes = Array.from(
              scope?.querySelectorAll?.('div[class*="valueItem--"][data-vid][data-disabled], [data-vid][data-disabled]') ?? []
            );
            const enabledCount = vidNodes.filter((n: any) => n?.getAttribute?.('data-disabled') === 'false').length;
            const sample = vidNodes.slice(0, 5).map((n: any) => {
              const vid = n?.getAttribute?.('data-vid') || '';
              const disabled = n?.getAttribute?.('data-disabled') || '';
              const cls = n?.getAttribute?.('class') || '';
              const text = String(n?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
              return { vid, disabled, cls, text };
            });
            return {
              hasPanel: !!panel,
              hasPanelBody: !!panelBody,
              skuItemCount: skuItems.length,
              vidCount: vidNodes.length,
              enabledVidCount: enabledCount,
              sample,
            };
          })
          .catch(() => null);

        const artifactsStartAt = Date.now();
        const artifacts = await this.saveDebugArtifacts(page, accountId, taobaoId, `${mode}_no_sku`);
        timings.saveSkuArtifactsMs = Date.now() - artifactsStartAt;
        console.warn(
          `[Scraper] [${mode}] NoSkuExtracted account=${accountId} taobaoId=${taobaoId} finalUrl=${page.url()} ms=${Date.now() - startedAt} artifacts=${artifacts?.prefix ?? 'n/a'} skuDiag=${skuDiag ? JSON.stringify(skuDiag) : 'n/a'}`
        );
      }

      console.log(
        `[Scraper] [${mode}] Success account=${accountId} taobaoId=${taobaoId} finalUrl=${page.url()} ms=${Date.now() - startedAt} finalPrice=${data.finalPrice ?? 'null'} originalPrice=${data.originalPrice ?? 'null'}`
      );
      logTimings('success');
      return { success: true, data };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[Scraper] [${mode}] Error account=${accountId} taobaoId=${taobaoId} url=${url} ms=${Date.now() - startedAt} message=${errorMessage}`
      );
      if (page) {
        const artifactsStartAt = Date.now();
        const artifacts = await this.saveDebugArtifacts(page, accountId, taobaoId, `${mode}_error`).catch(
          () => null
        );
        timings.saveArtifactsMs = Date.now() - artifactsStartAt;
        console.error(
          `[Scraper] [${mode}] ErrorArtifacts account=${accountId} taobaoId=${taobaoId} artifacts=${artifacts?.prefix ?? 'n/a'}`
        );
      }
      logTimings('error');
      return { success: false, error: errorMessage };
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  private async checkNeedLogin(page: Page): Promise<boolean> {
    // 检查是否跳转到登录页
    const url = page.url();
    if (url.includes('login.taobao.com') || url.includes('login.tmall.com')) {
      return true;
    }

    // 避免误判：商品页顶部导航等位置也可能出现“请登录”文本
    // 这里只在检测到明确的登录表单/登录 iframe 时才认为需要登录
    const loginSelectors = [
      '#fm-login-id',
      'input[name="fm-login-id"]',
      '#fm-login-password',
      'input[name="fm-login-password"]',
      '#login-form',
      '.login-box',
      '.qrcode-login',
      'iframe[src*="login.taobao.com"]',
      'iframe[src*="login.tmall.com"]',
    ];

    for (const selector of loginSelectors) {
      const el = await page.$(selector).catch(() => null);
      if (el) return true;
    }

    return false;
  }

  private async checkCaptcha(page: Page): Promise<boolean> {
    // 检查滑块验证码
    const captchaSelectors = [
      '#nc_1_n1z',
      '.nc-container',
      '.J_MIDDLEWARE_FRAME_WIDGET',
      'text=滑动验证',
      'text=请完成验证',
    ];

    for (const selector of captchaSelectors) {
      const element = await page.$(selector);
      if (element) {
        return true;
      }
    }

    return false;
  }

  private async checkAccessDenied(page: Page): Promise<boolean> {
    try {
      const url = page.url();
      if (url.includes('punish') || url.includes('secdev') || url.includes('waf')) {
        return true;
      }

      const title = await page.title().catch(() => '');
      const body = await page
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => '');
      const text = `${title}\n${body}`;

      return (
        text.includes('访问被拒绝') ||
        text.includes('访问受限') ||
        text.includes('访问异常') ||
        text.includes('请检查是否使用了代理') ||
        text.includes('系统检测到您的访问异常')
      );
    } catch {
      return false;
    }
  }

  private async waitForPriceElement(page: Page): Promise<void> {
    // 尝试等待价格元素出现
    const priceSelectors = [
      '.price-content',
      '.tm-price',
      '.tb-rmb-num',
      '#J_PromoPrice',
      '#J_StrPrice',
      '.tb-promo-price',
      '.highlightPrice--LlVWiXXs .text--LP7Wf49z',
    ];

    // 先快速检查一轮，避免每个 selector 都 wait 5s 导致整体阻塞太久
    for (const selector of priceSelectors) {
      const el = await page.$(selector).catch(() => null);
      if (el) return;
    }

    // 尝试等待页面出现任意带货币符号的文本（更通用，且有总超时）
    const waitSelectors = [
      '.highlightPrice--LlVWiXXs .text--LP7Wf49z',
      '.tb-rmb-num',
      '#J_PromoPrice .tb-rmb-num',
      '.tb-promo-price .tb-rmb-num',
      '#J_priceStd .tb-rmb-num',
    ];

    const waiters = waitSelectors.map((selector) =>
      page.locator(selector).first().waitFor({ state: 'attached', timeout: 12000 })
    );
    await Promise.any(waiters).catch(() => {});
  }

  private async extractPriceInfo(page: Page): Promise<ScrapedPrice> {
    // 使用JavaScript在页面中提取价格信息
    const result: ScrapedPrice = {
      finalPrice: null,
      originalPrice: null,
      title: null,
      imageUrl: null,
      couponInfo: null,
      promotionInfo: null,
    };

    // tsx/esbuild 可能会为函数名注入 __name(...) 调用，但页面上下文里没有该 helper
    // 这里提供一个 no-op 兼容实现，避免 page.evaluate 直接报错
    function __name(fn: any, _name?: string) {
      return fn;
    }

    // 提取标题
    const titleCandidates: Array<{ selector: string; attr?: string }> = [
      { selector: 'div[id^="SkuPanel_"] [class*="MainTitle"] span[title]', attr: 'title' },
      { selector: 'div[id^="SkuPanel_"] span[title][class*="mainTitle"]', attr: 'title' },
      { selector: 'div[id^="SkuPanel_"] span[title]', attr: 'title' },
      { selector: 'h1' },
      { selector: '.tb-main-title' },
      { selector: '.main-title' },
      { selector: '[class*="title"]' },
    ];

    for (const candidate of titleCandidates) {
      const el = await page.$(candidate.selector).catch(() => null);
      if (!el) continue;

      const attrText = candidate.attr ? await el.getAttribute(candidate.attr).catch(() => null) : null;
      const textContent = await el.textContent().catch(() => null);
      const text = (attrText ?? textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (text.includes('按图片搜索') || text.includes('图片搜索')) continue;

      result.title = text;
      break;
    }
    if (!result.title) {
      const t = await page.title().catch(() => '');
      result.title = t ? t.replace(/-淘宝网\s*$/, '').trim() : null;
    }

    // 提取图片
    const isPlaceholderImage = (url: string) => {
      const u = url.trim();
      if (!u) return true;
      return (
        u.includes('tps-2-2.png') ||
        u.includes('O1CN01CYtPWu1MUBqQAUK9D') ||
        u.includes('imgextra/i4/O1CN01CYtPWu1MUBqQAUK9D')
      );
    };

    const normalizeImageUrl = (url: string) => {
      const u = url.trim();
      if (!u) return null;
      if (u.startsWith('//')) return `https:${u}`;
      return u;
    };

    const imageCandidates: Array<{ selector: string; attrs: string[] }> = [
      { selector: '#picGalleryEle div[class*="thumbnailActive"] img[class*="thumbnailPic"]', attrs: ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'] },
      { selector: '#picGalleryEle img[class*="thumbnailPic"]', attrs: ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'] },
      { selector: '#mainPicImageEl', attrs: ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'] },
      { selector: 'img[id="mainPicImageEl"]', attrs: ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'] },
      { selector: 'img[class*="mainPic"]', attrs: ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'] },
      { selector: '.main-img img', attrs: ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'] },
      { selector: '[class*="gallery"] img', attrs: ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'] },
      { selector: '.pic-box img', attrs: ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'] },
    ];

    for (const candidate of imageCandidates) {
      const el = await page.$(candidate.selector).catch(() => null);
      if (!el) continue;

      let bestUrl: string | null = null;
      for (const attr of candidate.attrs) {
        const raw = await el.getAttribute(attr).catch(() => null);
        if (!raw) continue;
        const normalized = normalizeImageUrl(raw);
        if (!normalized) continue;
        if (isPlaceholderImage(normalized)) continue;
        bestUrl = normalized;
        break;
      }

      if (!bestUrl) {
        const placeholder = await el.getAttribute('placeholder').catch(() => null);
        const normalized = placeholder ? normalizeImageUrl(placeholder) : null;
        if (normalized && !isPlaceholderImage(normalized)) {
          bestUrl = normalized;
        }
      }

      if (bestUrl) {
        result.imageUrl = bestUrl;
        break;
      }
    }

    // 提取价格 - 多种选择器尝试
    const pricePatterns = [
      // 2025 SSR 详情页（你截图里的结构）
      { selector: '.highlightPrice--LlVWiXXs .text--LP7Wf49z', type: 'final' as const },
      { selector: '.subPrice--KfQ0yn4v span:nth-of-type(3)', type: 'original' as const },
      // 移动端淘宝
      { selector: '.price-content .price', type: 'final' as const },
      { selector: '.tm-price .tm-promo-price', type: 'final' as const },
      { selector: '.tb-rmb-num', type: 'final' as const },
      // PC端淘宝
      { selector: '#J_PromoPrice .tb-rmb-num', type: 'final' as const },
      { selector: '.tb-promo-price .tb-rmb-num', type: 'final' as const },
      { selector: '#J_StrPrice .tb-rmb-num', type: 'original' as const },
      { selector: '#J_priceStd .tb-rmb-num', type: 'final' as const },
      { selector: '#J_priceStd', type: 'final' as const },
      { selector: '[class*="Price--priceText"]', type: 'final' as const },
      { selector: '[class*="Price--originPrice"]', type: 'original' as const },
      // 通用
      { selector: '[class*="finalPrice"]', type: 'final' as const },
      { selector: '[class*="promoPrice"]', type: 'final' as const },
      { selector: '[class*="originPrice"]', type: 'original' as const },
    ];

    for (const pattern of pricePatterns) {
      const el = await page.$(pattern.selector).catch(() => null);
      const text = await el?.textContent().catch(() => null);
      if (!text) continue;
      const match = text.match(/[\d]+(?:\.[\d]+)?/);
      if (!match) continue;
      const price = parseFloat(match[0]);
      if (!Number.isFinite(price)) continue;

      if (pattern.type === 'final' && result.finalPrice === null) {
        result.finalPrice = price;
      }
      if (pattern.type === 'original' && result.originalPrice === null) {
        result.originalPrice = price;
      }

      if (result.finalPrice !== null && result.originalPrice !== null) break;
    }

    // 如果没找到结构化价格，尝试从文本中提取
    if (result.finalPrice === null) {
      const bodyText = await page
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => '');
      // 匹配 "到手价" 或 "券后价" 后面的数字
      const finalMatch = bodyText.match(/(?:到手价|券后价|活动价|促销价)[：:\s]*[¥￥]?([\d.]+)/);
      if (finalMatch) {
        result.finalPrice = parseFloat(finalMatch[1]);
      }

      if (result.finalPrice === null) {
        const anyCurrency = bodyText.match(/[¥￥]\s*([\d]+(?:\.[\d]+)?)/);
        if (anyCurrency) {
          result.finalPrice = parseFloat(anyCurrency[1]);
        }
      }
    }

    // 如果 DOM 文本都没提取到，尝试从页面全局状态对象里找（不同版本结构差异很大）
    if (result.finalPrice === null && result.originalPrice === null) {
      const html = await page.content().catch(() => '');
      const anyCurrency = html.match(/[¥￥]\s*([\d]+(?:\.[\d]+)?)/);
      if (anyCurrency) {
        result.finalPrice = parseFloat(anyCurrency[1]);
      }
    }

    // 提取优惠券信息
    const couponEl = await page.$('[class*="coupon"], [class*="quan"]').catch(() => null);
    const couponText = await couponEl?.textContent().catch(() => null);
    if (couponText) {
      result.couponInfo = couponText.trim() || null;
    }

    // 提取促销信息
    const promoEl = await page.$('[class*="promotion"], [class*="activity"]').catch(() => null);
    const promoText = await promoEl?.textContent().catch(() => null);
    if (promoText) {
      result.promotionInfo = promoText.trim() || null;
    }

    let variants: ScrapedSkuVariant[] = [];
    try {
      variants = await this.extractSkuVariants(page);
    } catch (error) {
      const msg = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
      console.warn(`[Scraper] [sku] ExtractError url=${page.url()} message=${msg}`);
      variants = [];
    }
    if (variants.length > 0) {
      if (result.imageUrl) {
        for (const v of variants) {
          if (!v.thumbnailUrl) v.thumbnailUrl = result.imageUrl;
        }
      }
      result.variants = variants;
    }

    return result;
  }

  private async extractSkuVariants(page: Page): Promise<ScrapedSkuVariant[]> {
    const skuTraceId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const skuLogPrefix = `[Scraper] [sku] [${skuTraceId}]`;
    const skuTrace: string[] = [];
    const pushSkuTrace = (msg: string) => {
      if (skuTrace.length >= 400) return;
      skuTrace.push(msg);
    };

    const parsePrice = (text: string | null) => {
      if (!text) return null;
      const match = text.match(/[\d]+(?:\.[\d]+)?/);
      if (!match) return null;
      const v = parseFloat(match[0]);
      return Number.isFinite(v) ? v : null;
    };

    await page
      .evaluate('var __name = (fn, _name) => fn; globalThis.__name = __name;')
      .catch(() => {});

    const getCurrentPrice = async () => {
      const finalText = await page
        .locator('div[class*="highlightPrice--"] span[class*="text--"], .highlightPrice--LlVWiXXs .text--LP7Wf49z')
        .first()
        .textContent()
        .catch(() => null);

      const origText = await page
        .locator('div[class*="subPrice--"] span[class*="text--"], .subPrice--KfQ0yn4v span:nth-of-type(3)')
        .last()
        .textContent()
        .catch(() => null);
      return {
        finalPrice: parsePrice(finalText),
        originalPrice: parsePrice(origText),
      };
    };

    await page
      .locator(
        'div[id^="SkuPanel_"] div[id*="SkuPanelBody"] div[class*="valueItem--"][data-vid][data-disabled], div[id^="SkuPanel_"] div[id*="SkuPanelBody"] [data-vid][data-disabled], div[id^="SkuPanel_"] [class*="skuItem--"] div[class*="valueItem--"][data-vid][data-disabled], div[id^="SkuPanel_"] [class*="skuItem--"] [data-vid][data-disabled], #skuOptionsArea div[class*="valueItem--"][data-vid][data-disabled], #skuOptionsArea [data-vid][data-disabled], [id*="skuOptionsArea"] div[class*="valueItem--"][data-vid][data-disabled], [id*="skuOptionsArea"] [data-vid][data-disabled]'
      )
      .first()
      .waitFor({ state: 'attached', timeout: 6000 })
      .catch(() => {});

    const optionCount = await page
      .evaluate(() => {
        const doc = (globalThis as any).document as any;
        const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
        const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
        const scope = panelBody || panel || doc;
        const nodes = Array.from(scope?.querySelectorAll?.('[data-vid][data-disabled]') ?? []);
        return nodes.length;
      })
      .catch(() => 0);

    if (optionCount > 0) {
      await page
        .locator('div[id^="SkuPanel_"] div[id*="SkuPanelBody"] [class*="skuItem--"], div[id^="SkuPanel_"] [class*="skuItem--"]')
        .first()
        .waitFor({ state: 'attached', timeout: 8000 })
        .catch(() => {});
    }

    const discoverGroups = async () =>
      page
        .evaluate(() => {
        const doc = (globalThis as any).document as any;

        const findSkuScope = () => {
          const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
          const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
          const byId = doc?.querySelector?.('#skuOptionsArea') || null;
          const byIdLike = (byId ? null : doc?.querySelector?.('[id*="skuOptionsArea"]')) || null;
          const inPanel = panel?.querySelector?.('#skuOptionsArea') || panel?.querySelector?.('[id*="skuOptionsArea"]') || null;
          return panelBody || byId || byIdLike || inPanel || panel;
        };

        const skuScope = findSkuScope();
        if (!skuScope) return [] as number[];
        const groups = Array.from(skuScope.querySelectorAll?.('[class*="skuItem--"]') ?? []);
        if (groups.length === 0) return [] as number[];

        const indexes: number[] = [];
        for (let i = 0; i < groups.length; i++) {
          const el = groups[i] as any;
          const vidCount = (el?.querySelectorAll?.('[data-vid]') ?? []).length;
          if (vidCount > 0) indexes.push(i);
        }

        if (indexes.length > 0) return indexes;
        return groups.map((_, i) => i);
        })
        .catch((error) => {
          const msg = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
          console.warn(`${skuLogPrefix} discoverGroupsEvalError url=${page.url()} message=${msg}`);
          return [] as number[];
        });

    let groupIndexes = await discoverGroups();
    if (groupIndexes.length === 0) {
      await page.waitForTimeout(1800);
      groupIndexes = await discoverGroups();
    }
    if (groupIndexes.length === 0 && optionCount > 0) {
      const groupCount = await page
        .evaluate(() => {
          const doc = (globalThis as any).document as any;
          const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
          const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
          const byId = doc?.querySelector?.('#skuOptionsArea') || null;
          const byIdLike = (byId ? null : doc?.querySelector?.('[id*="skuOptionsArea"]')) || null;
          const scope = panelBody || panel || byId || byIdLike || null;
          return (scope?.querySelectorAll?.('[class*="skuItem--"]') ?? []).length;
        })
        .catch(() => 0);

      if (groupCount > 0) {
        groupIndexes = Array.from({ length: groupCount }, (_, i) => i);
        console.warn(
          `${skuLogPrefix} GroupDiscoveryFallback url=${page.url()} optionCount=${optionCount} groupCount=${groupCount} groupIndexes=${JSON.stringify(
            groupIndexes
          )}`
        );
      }
    }

    if (groupIndexes.length === 0 && optionCount > 0) {
      const diag = await page
        .evaluate(() => {
          const doc = (globalThis as any).document as any;
          const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
          const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
          const byId = doc?.querySelector?.('#skuOptionsArea') || null;
          const byIdLike = (byId ? null : doc?.querySelector?.('[id*="skuOptionsArea"]')) || null;
          const scope = panelBody || panel || byId || byIdLike || null;
          const skuItemCount = (scope?.querySelectorAll?.('[class*="skuItem--"]') ?? []).length;
          const vidCount = (scope?.querySelectorAll?.('[data-vid][data-disabled]') ?? []).length;
          return {
            hasPanel: !!panel,
            hasPanelBody: !!panelBody,
            hasSkuOptionsArea: !!byId,
            hasSkuOptionsAreaLike: !!byIdLike,
            scopeTag: scope?.tagName || null,
            scopeId: scope?.getAttribute?.('id') || null,
            skuItemCount,
            vidCount,
          };
        })
        .catch(() => null);
      console.warn(
        `${skuLogPrefix} GroupDiscoveryEmpty url=${page.url()} optionCount=${optionCount} diag=${JSON.stringify(diag)} (sku DOM exists but groups not detected; likely render timing or container mismatch)`
      );
    }

    const stats = {
      groupCount: groupIndexes.length,
      dfsCalls: 0,
      leafVisits: 0,
      leafNoKey: 0,
      leafDuplicate: 0,
      leafStored: 0,
      alreadySelectedSkips: 0,
      clickAttempts: 0,
      clickOk: 0,
      clickFail: 0,
    };
    const leafSamples: Array<{ key: string; vidPath: string; finalPrice: number | null; originalPrice: number | null }> = [];
    const clickFailSamples: Array<{ groupIndex: number; vid: string }> = [];
    pushSkuTrace(`start url=${page.url()} groupIndexes=${JSON.stringify(groupIndexes)}`);

    const getAvailableVids = async (groupIndex: number) => {
      return page
        .evaluate((idx) => {
          const doc = (globalThis as any).document as any;
          const findSkuScope = () => {
            const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
            const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
            const byId = doc?.querySelector?.('#skuOptionsArea') || null;
            const byIdLike = (byId ? null : doc?.querySelector?.('[id*="skuOptionsArea"]')) || null;
            const inPanel = panel?.querySelector?.('#skuOptionsArea') || panel?.querySelector?.('[id*="skuOptionsArea"]') || null;
            return panelBody || byId || byIdLike || inPanel || panel;
          };

          const skuScope = findSkuScope();
          const groups = Array.from(skuScope?.querySelectorAll?.('[class*="skuItem--"]') ?? []);
          const group = (groups[idx] as any) || null;
          if (!group) return [] as string[];
          const vidSet = new Set<string>();
          const preferred = Array.from(
            group.querySelectorAll?.('div[class*="valueItem--"][data-vid][data-disabled="false"]') ?? []
          );
          const fallback =
            preferred.length > 0 ? [] : Array.from(group.querySelectorAll?.('[data-vid][data-disabled="false"]') ?? []);
          const nodes = preferred.length > 0 ? preferred : fallback;
          for (const n of nodes) {
            const el = n as any;
            const vid = el?.getAttribute?.('data-vid');
            if (vid) vidSet.add(vid);
          }
          return Array.from(vidSet);
        }, groupIndex)
        .catch((error) => {
          const msg = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
          console.warn(`${skuLogPrefix} getAvailableVidsEvalError url=${page.url()} groupIndex=${groupIndex} message=${msg}`);
          return [] as string[];
        });
    };

    const waitForStablePrice = async () => {
      const priceSelector = 'div[class*="highlightPrice--"] span[class*="text--"], .highlightPrice--LlVWiXXs .text--LP7Wf49z';
      const startedAt = Date.now();
      const timeoutMs = 5000;
      const stableMs = 450;
      const pollMs = 120;

      const readPriceToken = async () => {
        const raw = await page.locator(priceSelector).first().textContent().catch(() => null);
        const txt = String(raw || '').replace(/\s+/g, '').trim();
        const m = txt.match(/[\d]+(?:\.[\d]+)?/);
        return m ? m[0] : '';
      };

      let candidate = await readPriceToken();
      let candidateSince = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        await page.waitForTimeout(pollMs);
        const cur = await readPriceToken();

        if (cur !== candidate) {
          candidate = cur;
          candidateSince = Date.now();
          continue;
        }

        if (candidate && Date.now() - candidateSince >= stableMs) break;
      }
    };

    const clickVid = async (groupIndex: number, vid: string): Promise<boolean> => {
      await page
        .evaluate(
          ({ idx, v }) => {
            const doc = (globalThis as any).document as any;

            const findSkuScope = () => {
              const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
              const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
              const byId = doc?.querySelector?.('#skuOptionsArea') || null;
              const byIdLike = (byId ? null : doc?.querySelector?.('[id*="skuOptionsArea"]')) || null;
              const inPanel = panel?.querySelector?.('#skuOptionsArea') || panel?.querySelector?.('[id*="skuOptionsArea"]') || null;
              return panelBody || byId || byIdLike || inPanel || panel;
            };

            const skuScope = findSkuScope();
            const groups = Array.from(skuScope?.querySelectorAll?.('[class*="skuItem--"]') ?? []);
            const group = (groups[idx] as any) || null;
            if (!group) return;

            const preferred = Array.from(
              group.querySelectorAll?.(`div[class*="valueItem--"][data-vid="${v}"][data-disabled="false"]`) ?? []
            );
            const fallback =
              preferred.length > 0
                ? []
                : Array.from(group.querySelectorAll?.(`[data-vid="${v}"][data-disabled="false"]`) ?? []);
            const nodes = preferred.length > 0 ? preferred : fallback;
            const target = (nodes[0] as any) || null;
            if (!target) return;
            try {
              target?.scrollIntoView?.({ block: 'center', inline: 'center' });
            } catch {
            }
            target?.click?.();
          },
          { idx: groupIndex, v: vid }
        )
        .catch(() => {});

      const ok = await page
        .waitForFunction(
          (arg) => {
            const { idx, v } = (arg || {}) as any;
            const doc = (globalThis as any).document as any;
            const isSelected = (el: any) => {
              if (!el) return false;
              const cls = (el.getAttribute?.('class') || '') as string;
              if (cls.includes('isSelected')) return true;
              const ariaChecked = el.getAttribute?.('aria-checked');
              if (ariaChecked === 'true') return true;
              const ariaSelected = el.getAttribute?.('aria-selected');
              if (ariaSelected === 'true') return true;
              const dataSelected = el.getAttribute?.('data-selected');
              if (dataSelected === 'true') return true;
              return false;
            };
            const findSkuScope = () => {
              const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
              const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
              const byId = doc?.querySelector?.('#skuOptionsArea') || null;
              const byIdLike = (byId ? null : doc?.querySelector?.('[id*="skuOptionsArea"]')) || null;
              const inPanel = panel?.querySelector?.('#skuOptionsArea') || panel?.querySelector?.('[id*="skuOptionsArea"]') || null;
              return panelBody || byId || byIdLike || inPanel || panel;
            };

            const skuScope = findSkuScope();
            const groups = Array.from(skuScope?.querySelectorAll?.('[class*="skuItem--"]') ?? []);
            const group = (groups[idx] as any) || null;
            if (!group) return false;
            const el =
              group?.querySelector?.(`div[class*="valueItem--"][data-vid="${v}"]`) || group?.querySelector?.(`[data-vid="${v}"]`);

            let cur: any = el;
            for (let i = 0; i < 4 && cur; i++) {
              if (isSelected(cur)) return true;
              cur = cur.parentElement;
            }
            return false;
          },
          { idx: groupIndex, v: vid },
          { timeout: 9000 }
        )
        .then(() => true)
        .catch(() => false);

      return ok;
    };

    const getSelectionSnapshot = async (chosenVids?: Array<string | null> | null) => {
      return page
        .evaluate(({ indexes, vids }) => {
          const doc = (globalThis as any).document as any;
          const loc = (globalThis as any).location as any;
          const findSkuScope = () => {
            const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
            const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
            const byId = doc?.querySelector?.('#skuOptionsArea') || null;
            const byIdLike = (byId ? null : doc?.querySelector?.('[id*="skuOptionsArea"]')) || null;
            const inPanel = panel?.querySelector?.('#skuOptionsArea') || panel?.querySelector?.('[id*="skuOptionsArea"]') || null;
            return panelBody || byId || byIdLike || inPanel || panel;
          };

          const skuScope = findSkuScope();
          const groups = Array.from(skuScope?.querySelectorAll?.('[class*="skuItem--"]') ?? []);
          if (groups.length === 0) return { selections: [], skuId: null, skuProperties: null, thumbnailUrl: null };

          const normalizeImg = (raw: string | null) => {
            if (!raw) return null;
            const u = String(raw).trim();
            if (!u) return null;
            if (u.startsWith('//')) return `https:${u}`;
            return u;
          };

          const readImg = (root: any) => {
            const img = root?.querySelector?.('img');
            if (!img) return null;
            const attrs = ['src', 'data-src', 'data-ks-lazyload', 'data-lazy-src', 'data-original'];
            for (const a of attrs) {
              const v = img.getAttribute?.(a);
              const n = normalizeImg(v);
              if (n) return n;
            }
            return null;
          };

          const selections: Array<{ label: string; vid: string; value: string }> = [];
          let thumbnailUrl: string | null = null;
          for (let i = 0; i < indexes.length; i++) {
            const idx = indexes[i];
            const group = (groups[idx] as any) || null;
            if (!group) continue;
            const labelEl =
              group?.querySelector?.('[class*="labelWrap--"] span[title]') ||
              group?.querySelector?.('[class*="ItemLabel--"] span[title]') ||
              group?.querySelector?.('span[title]') ||
              null;
            const label = (labelEl?.getAttribute('title') || labelEl?.textContent || '').trim();

            const expectedVid = vids?.[i] ? String(vids[i]) : null;

            const candidates = expectedVid
              ? Array.from(group?.querySelectorAll?.(`[data-vid="${expectedVid}"]`) ?? [])
              : [];
            const preferred =
              (candidates.find((n: any) => ((n.getAttribute?.('class') || '') as string).includes('valueItem--')) as any) ||
              (candidates[0] as any) ||
              null;

            const selected =
              preferred ||
              (group?.querySelector?.('[data-vid][data-disabled="false"][aria-checked="true"]') as any) ||
              (group?.querySelector?.('[data-vid][data-disabled="false"][aria-selected="true"]') as any) ||
              (group?.querySelector?.('[data-vid][data-disabled="false"][data-selected="true"]') as any) ||
              (group?.querySelector?.('[data-vid][data-disabled][class*="isSelected"]') as any) ||
              null;
            const vid = selected?.getAttribute?.('data-vid') || '';
            const valueEl = selected?.querySelector?.('span[title]') || null;
            const value = (
              (valueEl?.getAttribute('title') || valueEl?.textContent || selected?.textContent || '').replace(/\s+/g, ' ').trim()
            );
            if (vid) selections.push({ label: label || `规格${idx + 1}`, vid, value });

            const imgUrl = readImg(selected);
            if (imgUrl) thumbnailUrl = imgUrl;
          }

          const params = new URLSearchParams(loc?.search || '');
          return {
            selections,
            skuId: params.get('skuId'),
            skuProperties: params.get('sku_properties'),
            thumbnailUrl,
          };
        }, { indexes: groupIndexes, vids: chosenVids ?? null })
        .catch(() => ({ selections: [] as Array<{ label: string; vid: string; value: string }>, skuId: null as string | null, skuProperties: null as string | null, thumbnailUrl: null as string | null }));
    };

    if (groupIndexes.length === 0) {
      if (optionCount > 0) return [];
      const snap = await page
        .evaluate(() => {
          const loc = (globalThis as any).location as any;
          const params = new URLSearchParams(loc?.search || '');
          return {
            skuId: params.get('skuId'),
            skuProperties: params.get('sku_properties'),
          };
        })
        .catch(() => ({ skuId: null as string | null, skuProperties: null as string | null }));

      const price = await getCurrentPrice();
      const key = snap.skuId || snap.skuProperties;
      if (!key) return [];
      return [
        {
          skuKey: key,
          skuId: snap.skuId,
          skuProperties: snap.skuProperties,
          vidPath: '',
          selections: [],
          finalPrice: price.finalPrice,
          originalPrice: price.originalPrice,
          thumbnailUrl: null,
        },
      ];
    }

    const maxVariants = 200;
    const results: ScrapedSkuVariant[] = [];
    const seen = new Set<string>();
    const chosenVids: Array<string | null> = Array.from({ length: groupIndexes.length }, () => null);

    const dfs = async (depth: number) => {
      stats.dfsCalls += 1;
      if (results.length >= maxVariants) return;
      if (depth >= groupIndexes.length) {
        stats.leafVisits += 1;
        await waitForStablePrice().catch(() => {});
        const snap = await getSelectionSnapshot(chosenVids);
        const price = await getCurrentPrice();
        const vidPath = chosenVids.filter((v) => !!v).join(';');
        const skuKey = snap.selections.map((s) => `${s.label}=${s.value}`).join(' / ');
        const key = snap.skuId || snap.skuProperties || vidPath;
        if (!key) {
          stats.leafNoKey += 1;
          pushSkuTrace(`leaf:noKey vidPath=${vidPath} skuKey=${skuKey}`);
          return;
        }
        if (seen.has(key)) {
          stats.leafDuplicate += 1;
          return;
        }
        seen.add(key);
        results.push({
          skuKey,
          skuId: snap.skuId,
          skuProperties: snap.skuProperties,
          vidPath,
          selections: snap.selections,
          finalPrice: price.finalPrice,
          originalPrice: price.originalPrice,
          thumbnailUrl: snap.thumbnailUrl,
        });
        stats.leafStored += 1;
        if (leafSamples.length < 12) {
          leafSamples.push({ key, vidPath, finalPrice: price.finalPrice, originalPrice: price.originalPrice });
        }
        return;
      }

      const groupIndex = groupIndexes[depth];
      const vids = await getAvailableVids(groupIndex);
      if (depth < 4) {
        pushSkuTrace(
          `depth=${depth} groupIndex=${groupIndex} vids=${vids.length} sample=${JSON.stringify(vids.slice(0, 8))}`
        );
      }
      if (vids.length === 0) {
        chosenVids[depth] = null;
        await dfs(depth + 1);
        return;
      }

      for (const vid of vids) {
        if (results.length >= maxVariants) return;
        chosenVids[depth] = vid;
        const alreadySelected = await page
          .evaluate(
            ({ idx, v }) => {
              const doc = (globalThis as any).document as any;
              const isSelected = (el: any) => {
                if (!el) return false;
                const cls = (el.getAttribute?.('class') || '') as string;
                if (cls.includes('isSelected')) return true;
                const ariaChecked = el.getAttribute?.('aria-checked');
                if (ariaChecked === 'true') return true;
                const ariaSelected = el.getAttribute?.('aria-selected');
                if (ariaSelected === 'true') return true;
                const dataSelected = el.getAttribute?.('data-selected');
                if (dataSelected === 'true') return true;
                return false;
              };
              const findSkuScope = () => {
                const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
                const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
                const byId = doc?.querySelector?.('#skuOptionsArea') || null;
                const byIdLike = (byId ? null : doc?.querySelector?.('[id*="skuOptionsArea"]')) || null;
                const inPanel = panel?.querySelector?.('#skuOptionsArea') || panel?.querySelector?.('[id*="skuOptionsArea"]') || null;
                return panelBody || byId || byIdLike || inPanel || panel;
              };

              const skuScope = findSkuScope();
              const groups = Array.from(skuScope?.querySelectorAll?.('[class*="skuItem--"]') ?? []);
              const group = (groups[idx] as any) || null;
              if (!group) return false;
              const el =
                group?.querySelector?.(`div[class*="valueItem--"][data-vid="${v}"]`) || group?.querySelector?.(`[data-vid="${v}"]`);

              let cur: any = el;
              for (let i = 0; i < 4 && cur; i++) {
                if (isSelected(cur)) return true;
                cur = cur.parentElement;
              }
              return false;
            },
            { idx: groupIndex, v: vid }
          )
          .catch(() => false);

        if (!alreadySelected) {
          stats.clickAttempts += 1;
          const ok = await clickVid(groupIndex, vid).catch(() => false);
          if (ok) {
            stats.clickOk += 1;
          } else {
            stats.clickFail += 1;
            if (clickFailSamples.length < 12) clickFailSamples.push({ groupIndex, vid });
            pushSkuTrace(`clickFail groupIndex=${groupIndex} vid=${vid}`);
          }
          await page.waitForTimeout(200);
        } else {
          stats.alreadySelectedSkips += 1;
        }

        await dfs(depth + 1);
      }
    };

    await dfs(0);
    if (results.length === 0 && groupIndexes.length > 0) {
      const groupMeta = await page
        .evaluate((indexes) => {
          const doc = (globalThis as any).document as any;

          const findSkuArea = () => {
            const panel = doc?.querySelector?.('div[id^="SkuPanel_"]') || null;
            const panelBody = panel?.querySelector?.('div[id*="SkuPanelBody"]') || null;
            const byId = doc?.querySelector?.('#skuOptionsArea') || null;
            return panelBody || panel || byId || doc;
          };

          const skuArea = findSkuArea();
          const groups = Array.from(skuArea?.querySelectorAll?.('[class*="skuItem--"]') ?? []);

          return (indexes as number[]).map((idx) => {
            const group = (groups.length > 0 ? (groups[idx] as any) : (skuArea?.children?.[idx] as any)) as any;
            if (!group) return { idx, ok: false };

            const labelEl =
              group?.querySelector?.('[class*="labelWrap--"] span[title]') ||
              group?.querySelector?.('[class*="ItemLabel--"] span[title]') ||
              group?.querySelector?.('span[title]') ||
              null;
            const label = (labelEl?.getAttribute?.('title') || labelEl?.textContent || '').trim();

            const nodes = Array.from(
              group?.querySelectorAll?.('div[class*="valueItem--"][data-vid][data-disabled], [data-vid][data-disabled]') ?? []
            ) as any[];
            const enabled = nodes.filter((n) => n?.getAttribute?.('data-disabled') === 'false');
            const sample = enabled.slice(0, 8).map((n) => {
              const vid = n?.getAttribute?.('data-vid') || '';
              const cls = n?.getAttribute?.('class') || '';
              const text = String(n?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
              return { vid, cls, text };
            });
            return {
              idx,
              ok: true,
              label,
              nodeCount: nodes.length,
              enabledCount: enabled.length,
              enabledSample: sample,
            };
          });
        }, groupIndexes)
        .catch(() => null);

      console.warn(
        `${skuLogPrefix} NoVariantsExtracted url=${page.url()} groupIndexes=${JSON.stringify(
          groupIndexes
        )} stats=${JSON.stringify(stats)} groupMeta=${groupMeta ? JSON.stringify(groupMeta) : 'n/a'} leafSamples=${JSON.stringify(
          leafSamples
        )} clickFailSamples=${JSON.stringify(clickFailSamples)} trace=${JSON.stringify(skuTrace)}`
      );
    }
    return results;
  }

  async closeContext(accountId: string): Promise<void> {
    const exact = this.contexts.get(accountId);
    if (exact) {
      await exact.close().catch(() => {});
      this.contexts.delete(accountId);
      return;
    }

    const prefix = `${accountId}:`;
    const keys = Array.from(this.contexts.keys()).filter((k) => k.startsWith(prefix));
    for (const key of keys) {
      const ctx = this.contexts.get(key);
      if (ctx) {
        await ctx.close().catch(() => {});
      }
      this.contexts.delete(key);
    }
  }

  async close(): Promise<void> {
    const keys = Array.from(this.contexts.keys());
    for (const id of keys) {
      await this.closeContext(id);
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    console.log('[Scraper] Browser closed');
  }

  /**
   * 启动登录流程（有头模式，用于手动扫码登录）
   */
  async startLoginSession(accountId: string): Promise<{ page: Page; context: BrowserContext }> {
    // 为登录创建一个有头浏览器
    const browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      ...DESKTOP_DEVICE,
    });

    const stealth = await loadStealthScript();
    await context.addInitScript(stealth);
    await context.addInitScript(`globalThis.__name = (fn, _name) => fn; var __name = globalThis.__name;`);

    const page = await context.newPage();
    await page.goto('https://login.taobao.com/member/login.jhtml');

    return { page, context };
  }

  /**
   * 保存登录后的cookies
   */
  async saveCookies(context: BrowserContext): Promise<string> {
    const cookies = await context.cookies();
    return JSON.stringify(cookies);
  }
}

// 单例
export const scraper = new TaobaoScraper();
