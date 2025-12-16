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
  rawHtml?: string;
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
      await context.addInitScript(`var __name = (fn, _name) => fn;`).catch(() => {});
      return context;
    }

    const device = mode === 'mobile' ? MOBILE_DEVICE : DESKTOP_DEVICE;

    context = await this.browser!.newContext({ ...device, storageState: undefined });

    const stealth = await loadStealthScript();
    await context.addInitScript(stealth);
    await context.addInitScript(`var __name = (fn, _name) => fn;`);

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
      await page.addInitScript(`var __name = (fn, _name) => fn;`).catch(() => {});

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
      await sleep(500);
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
    for (const selector of ['h1', '[class*="title"]', '.tb-main-title', '.main-title']) {
      const el = await page.$(selector).catch(() => null);
      const text = await el?.textContent().catch(() => null);
      if (text && text.trim()) {
        result.title = text.trim();
        break;
      }
    }
    if (!result.title) {
      const t = await page.title().catch(() => '');
      result.title = t ? t.replace(/-淘宝网\s*$/, '').trim() : null;
    }

    // 提取图片
    for (const selector of ['.main-img img', '[class*="gallery"] img', '.pic-box img']) {
      const el = await page.$(selector).catch(() => null);
      const src = await el?.getAttribute('src').catch(() => null);
      if (src) {
        result.imageUrl = src;
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

    return result;
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
    await context.addInitScript(`var __name = (fn, _name) => fn;`);

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
