import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import { PrismaClient } from '@prisma/client';
import { encryptCookies } from '../utils/helpers.js';
import { config } from '../config/index.js';
import { getCookieValue, getSessionByToken } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';

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

type WsUser = { id: string; role: 'admin' | 'operator' };

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new Error(`Timeout: ${label}`)), timeoutMs);
    (id as any).unref?.();
  });
  return (await Promise.race([promise, timeout])) as T;
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

  initWebSocket(_server: any): void {
    // Use noServer mode so we can route upgrades for multiple WS endpoints on the same HTTP server
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws, req) => {
      const origin = String(req.headers.origin || '');
      const allowed = ((config as any).cors?.origins as string[] | undefined) || [];
      const isDevLocalOrigin =
        config.env !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
      if (origin && allowed.length > 0 && !allowed.includes(origin) && !isDevLocalOrigin) {
        ws.close(1008, 'Forbidden origin');
        return;
      }

      const sid = getCookieValue(String(req.headers.cookie || ''), SESSION_COOKIE_NAME);
      if (!sid) {
        ws.close(1008, 'Unauthorized');
        return;
      }

      // IMPORTANT: attach message handler immediately to avoid losing the first client message
      // (client may send `start_login` right after WS open, while we are still awaiting DB auth).
      const pendingMessages: string[] = [];
      let user: WsUser | null = null;
      let ready = false;

      const handleMessage = async (message: string) => {
        if (!user) return;
        try {
          const data = JSON.parse(message);
          if (data.type === 'start_login') {
            await this.startLoginSession(String(data.accountId || ''), ws, user);
          } else if (data.type === 'cancel_login') {
            if (user.role === 'operator') {
              const acc = await prisma.taobaoAccount.findUnique({
                where: { id: String(data.accountId || '') },
                select: { userId: true },
              });
              if (!acc || acc.userId !== user.id) {
                ws.send(JSON.stringify({ type: 'error', message: 'Forbidden' }));
                return;
              }
            }
            await this.cancelLoginSession(String(data.accountId || ''));
          }
        } catch (error) {
          console.error('[LoginManager] Message error:', error);
          ws.send(JSON.stringify({ type: 'error', message: String(error) }));
        }
      };

      ws.on('message', (raw) => {
        const msg = raw.toString();
        if (!ready) {
          if (pendingMessages.length < 10) pendingMessages.push(msg);
          return;
        }
        void handleMessage(msg);
      });

      void (async () => {
        const session = await getSessionByToken(prisma, { token: sid });
        if (!session) {
          ws.close(1008, 'Unauthorized');
          return;
        }

        user = { id: session.user.id, role: session.user.role };
        console.log('[LoginManager] WebSocket connected');
        ready = true;
        for (const msg of pendingMessages.splice(0, pendingMessages.length)) {
          await handleMessage(msg);
        }

        ws.on('close', () => {
          console.log('[LoginManager] WebSocket disconnected');
          for (const [accountId, s] of this.sessions) {
            if (s.ws === ws) {
              this.cancelLoginSession(accountId);
            }
          }
        });
      })().catch((err) => {
        console.error('[LoginManager] WS auth error:', err);
        ws.close(1011, 'Internal error');
      });
    });

    console.log('[LoginManager] WebSocket server initialized');
  }

  /**
   * Route HTTP upgrade requests to this WS server.
   * Returns true when the upgrade is handled.
   */
  handleUpgrade(req: any, socket: any, head: any): boolean {
    if (!this.wss) return false;
    try {
      const base = `http://${req.headers.host || 'localhost'}`;
      const url = new URL(String(req.url || ''), base);
      if (url.pathname !== '/ws/login') return false;
    } catch {
      return false;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit('connection', ws, req);
    });
    return true;
  }

  async startLoginSession(accountId: string, ws: WebSocket, user: WsUser): Promise<void> {
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

    if (user.role === 'operator' && account.userId !== user.id) {
      ws.send(JSON.stringify({ type: 'error', message: 'Forbidden' }));
      return;
    }

    console.log(`[LoginManager] Starting login session for account: ${account.name} accountId=${accountId}`);

    try {
      // 不使用 remote-debugging-port：部分 Windows/服务器环境可能因端口保留/权限导致 Chrome 启动异常，
      // 且本登录流程不需要 CDP 调试端口。
      let browser: Browser;
      try {
        browser = await withTimeout(
          chromium.launch({
            headless: false,
            channel: 'chrome', // 优先使用系统安装的 Chrome
            args: [
              '--disable-blink-features=AutomationControlled',
              '--disable-infobars',
              '--no-first-run',
              '--no-default-browser-check',
            ],
          }),
          25_000,
          'launch chrome'
        );
      } catch {
        // 回退到 Playwright 自带的 Chromium
        browser = await withTimeout(
          chromium.launch({
            headless: false,
            args: [
              '--disable-blink-features=AutomationControlled',
              '--disable-infobars',
            ],
          }),
          25_000,
          'launch chromium'
        );
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

      await withTimeout(page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }), 30_000, 'goto login page');
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
