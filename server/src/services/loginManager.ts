import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import { PrismaClient } from '@prisma/client';
import { encryptCookies } from '../utils/helpers.js';

const prisma = new PrismaClient();

const LOGIN_URL = 'https://login.taobao.com/member/login.jhtml';
const SCREENSHOT_INTERVAL_MS = 1500;
const PAGE_STABLE_TIMEOUT_MS = 10000;

// 桌面端配置：显示完整登录页（支持扫码/账号密码两种方式）
const DESKTOP_DEVICE = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
};

interface LoginSession {
  accountId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  ws: WebSocket;
  intervalId: NodeJS.Timeout | null;
  isCapturing: boolean;
}

// 判断是否为导航相关错误
function isNavigationError(error: unknown): boolean {
  const msg = String(error ?? '');
  return msg.includes('page is navigating') ||
         msg.includes('Execution context was destroyed') ||
         msg.includes('Target closed') ||
         msg.includes('has been closed') ||
         msg.includes('frame was detached') ||
         msg.includes('Navigation failed') ||
         msg.includes('page has been closed');
}

// 等待页面稳定
async function waitForPageStable(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: PAGE_STABLE_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  } catch {
    // ignore
  }
}

// 根据 accountId 生成唯一的调试端口
function getDebugPort(accountId: string): number {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = ((hash << 5) - hash + accountId.charCodeAt(i)) | 0;
  }
  return 9222 + (Math.abs(hash) % 200);
}

// 通过 Cookie 检查是否已登录（不中断用户操作）
function checkLoginByCookies(cookies: Array<{ name: string; domain: string }>): boolean {
  const authCookieNames = ['_m_h5_tk', '_m_h5_tk_enc', 'login', 'munb', 'lgc', 'tracknick'];
  const taobaoDomains = ['.taobao.com', '.tmall.com', '.alicdn.com'];

  return authCookieNames.some(name =>
    cookies.some(c =>
      c.name === name && taobaoDomains.some(d => c.domain.includes(d.replace('.', '')))
    )
  );
}

class LoginManager {
  private sessions: Map<string, LoginSession> = new Map();
  private wss: WebSocketServer | null = null;

  initWebSocket(server: any): void {
    this.wss = new WebSocketServer({ server, path: '/ws/login' });

    this.wss.on('connection', (ws) => {
      console.log('[LoginManager] WebSocket connected');

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          if (data.type === 'start_login') {
            await this.startLoginSession(data.accountId, ws);
          } else if (data.type === 'cancel_login') {
            await this.cancelLoginSession(data.accountId);
          }
        } catch (error) {
          console.error('[LoginManager] Message error:', error);
          ws.send(JSON.stringify({ type: 'error', message: String(error) }));
        }
      });

      ws.on('close', () => {
        console.log('[LoginManager] WebSocket disconnected');
        for (const [accountId, session] of this.sessions) {
          if (session.ws === ws) {
            this.cancelLoginSession(accountId);
          }
        }
      });
    });

    console.log('[LoginManager] WebSocket server initialized');
  }

  async startLoginSession(accountId: string, ws: WebSocket): Promise<void> {
    if (this.sessions.has(accountId)) {
      await this.cancelLoginSession(accountId);
    }

    const account = await prisma.taobaoAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      ws.send(JSON.stringify({ type: 'error', message: 'Account not found' }));
      return;
    }

    console.log(`[LoginManager] Starting login session for account: ${account.name}`);

    try {
      const debugPort = getDebugPort(accountId);

      // 使用非 headless 模式 + remote-debugging-port 避免检测
      let browser: Browser;
      try {
        browser = await chromium.launch({
          headless: false,
          channel: 'chrome', // 优先使用系统安装的 Chrome
          args: [
            `--remote-debugging-port=${debugPort}`,
            '--remote-debugging-address=127.0.0.1', // 仅本地访问
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--no-first-run',
            '--no-default-browser-check',
          ],
        });
      } catch {
        // 回退到 Playwright 自带的 Chromium
        browser = await chromium.launch({
          headless: false,
          args: [
            `--remote-debugging-port=${debugPort}`,
            '--remote-debugging-address=127.0.0.1',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
          ],
        });
      }

      const context = await browser.newContext(DESKTOP_DEVICE);

      // 注入反检测脚本
      await context.addInitScript(`
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        window.chrome = { runtime: {} };
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      `);

      const page = await context.newPage();

      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await waitForPageStable(page);

      const session: LoginSession = {
        accountId,
        browser,
        context,
        page,
        ws,
        intervalId: null,
        isCapturing: false,
      };

      this.sessions.set(accountId, session);
      ws.send(JSON.stringify({ type: 'login_started', accountId }));

      // 开始定时截图
      session.intervalId = setInterval(() => {
        this.captureAndCheck(session);
      }, SCREENSHOT_INTERVAL_MS);

      // 立即执行一次
      await this.captureAndCheck(session);

    } catch (error) {
      console.error('[LoginManager] Start session error:', error);
      ws.send(JSON.stringify({ type: 'error', message: String(error) }));
    }
  }

  private async captureAndCheck(session: LoginSession): Promise<void> {
    if (session.isCapturing) return;
    session.isCapturing = true;

    try {
      const { page, ws, accountId, context } = session;

      if (ws.readyState !== WebSocket.OPEN || page.isClosed()) {
        await this.cancelLoginSession(accountId);
        return;
      }

      // 等待页面稳定再截图
      await waitForPageStable(page);

      // 截图（带重试）
      let screenshot: Buffer | null = null;
      try {
        screenshot = await page.screenshot({ type: 'jpeg', quality: 85, timeout: 15000 });
      } catch (error) {
        if (isNavigationError(error)) {
          await waitForPageStable(page);
          try {
            screenshot = await page.screenshot({ type: 'jpeg', quality: 85, timeout: 15000 });
          } catch {
            // ignore
          }
        }
      }

      if (screenshot) {
        ws.send(JSON.stringify({
          type: 'screenshot',
          accountId,
          image: screenshot.toString('base64'),
        }));
      }

      // 检查是否离开登录页（可能已登录）- 使用 Cookie 验证，不中断用户操作
      const currentUrl = page.url();
      const isLoginPage = currentUrl.includes('login.taobao.com') ||
                          currentUrl.includes('login.tmall.com');

      // 如果离开了登录页，或者检测到关键 Cookie，认为已登录
      if (!isLoginPage) {
        const cookies = await context.cookies();
        const isLoggedIn = checkLoginByCookies(cookies);

        if (isLoggedIn) {
          const cookiesJson = JSON.stringify(cookies);

          await prisma.taobaoAccount.update({
            where: { id: accountId },
            data: {
              cookies: encryptCookies(cookiesJson),
              isActive: true,
              lastLoginAt: new Date(),
              status: 'IDLE',
              errorCount: 0,
              lastError: null,
            },
          });

          ws.send(JSON.stringify({
            type: 'login_success',
            accountId,
            message: '登录成功！Cookies 已保存。',
          }));

          await this.cancelLoginSession(accountId);
          return;
        }
      }

    } catch (error) {
      console.error('[LoginManager] Capture error:', error);
    } finally {
      session.isCapturing = false;
    }
  }

  async cancelLoginSession(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;

    console.log(`[LoginManager] Canceling session for account: ${accountId}`);

    if (session.intervalId) {
      clearInterval(session.intervalId);
    }

    try {
      await session.page.close().catch(() => {});
      await session.context.close().catch(() => {});
      await session.browser.close().catch(() => {});
    } catch {
      // ignore
    }

    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'login_cancelled', accountId }));
    }

    this.sessions.delete(accountId);
  }

  getActiveSessions(): number {
    return this.sessions.size;
  }
}

export const loginManager = new LoginManager();
