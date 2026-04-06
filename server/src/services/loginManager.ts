import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import { PrismaClient } from '@prisma/client';
import { encryptCookies } from '../utils/helpers.js';
import { config } from '../config/index.js';
import { getCookieValue, getSessionByToken } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { agentHub } from './agentHub.js';

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

type LoginSession =
  | {
      mode: 'local';
      accountId: string;
      browser: Browser;
      context: BrowserContext;
      page: Page;
      ws: WebSocket;
      intervalId: NodeJS.Timeout | null;
      isCapturing: boolean;
    }
  | {
      mode: 'agent';
      accountId: string;
      agentId: string;
      ws: WebSocket;
      cancelled: boolean;
    };

type WsUser = { id: string; role: 'admin' | 'operator' };
type AgentLoginControlAction = 'click' | 'type' | 'key' | 'drag';

function isDevLocalOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function defaultPort(protocol: string): string {
  if (protocol === 'https:') return '443';
  if (protocol === 'http:') return '80';
  return '';
}

function isSameHostOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  let reqUrl: URL;
  try {
    reqUrl = new URL(`${originUrl.protocol}//${hostHeader}`);
  } catch {
    return false;
  }

  const originHost = originUrl.hostname.toLowerCase();
  const reqHost = reqUrl.hostname.toLowerCase();
  if (originHost !== reqHost) return false;

  const expectedPort = defaultPort(originUrl.protocol);
  const originPort = originUrl.port || expectedPort;
  const reqPort = reqUrl.port || expectedPort;
  return originPort === reqPort;
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
      const allowAll = allowed.includes('*');
      const allowExact = allowed.includes(origin);
      const allowDevLocal = config.env !== 'production' && isDevLocalOrigin(origin);
      const allowSameHost = origin ? isSameHostOrigin(origin, String(req.headers.host || '')) : false;

      if (origin && allowed.length > 0 && !allowAll && !allowExact && !allowDevLocal && !allowSameHost) {
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
          } else if (data.type === 'login_control') {
            await this.handleLoginControl(ws, data);
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
          console.error('[LoginManager] 消息处理错误:', error);
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
        console.log('[LoginManager] 已连接(WebSocket)');
        ready = true;
        for (const msg of pendingMessages.splice(0, pendingMessages.length)) {
          await handleMessage(msg);
        }

        ws.on('close', () => {
          console.log('[LoginManager] 已断开(WebSocket)');
          for (const [accountId, s] of this.sessions) {
            if (s.ws === ws) {
              this.cancelLoginSession(accountId);
            }
          }
        });
      })().catch((err) => {
        console.error('[LoginManager] 鉴权失败(WS):', err);
        ws.close(1011, 'Internal error');
      });
    });

    console.log('[LoginManager] 服务已启动(WebSocket)');
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

  private async handleLoginControl(ws: WebSocket, data: any): Promise<void> {
    const accountId = String(data?.accountId || '').trim();
    const action = String(data?.action || '').trim() as AgentLoginControlAction;
    const session = this.sessions.get(accountId);

    const sendControlError = (message: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'login_control_error', accountId, message }));
      }
    };

    if (!accountId) {
      sendControlError('缺少 accountId');
      return;
    }

    if (!session || session.ws !== ws) {
      sendControlError('当前账号没有活跃登录会话');
      return;
    }

    if (session.mode !== 'agent' || session.cancelled) {
      sendControlError('当前登录会话不支持远程控制');
      return;
    }

    const payload: Record<string, unknown> = { accountId, action };

    try {
      if (action === 'click') {
        const x = Number(data?.x);
        const y = Number(data?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('点击坐标无效');
        }
        payload.x = x;
        payload.y = y;
      } else if (action === 'type') {
        const text = String(data?.text || '');
        if (!text) throw new Error('输入内容不能为空');
        payload.text = text.slice(0, 500);
      } else if (action === 'key') {
        const key = String(data?.key || '').trim();
        if (!key) throw new Error('按键不能为空');
        payload.key = key.slice(0, 64);
      } else if (action === 'drag') {
        const fromX = Number(data?.fromX);
        const fromY = Number(data?.fromY);
        const toX = Number(data?.toX);
        const toY = Number(data?.toY);
        if (![fromX, fromY, toX, toY].every((v) => Number.isFinite(v))) {
          throw new Error('拖动坐标无效');
        }
        payload.fromX = fromX;
        payload.fromY = fromY;
        payload.toX = toX;
        payload.toY = toY;
      } else {
        throw new Error('不支持的控制动作');
      }

      const result = await agentHub.call<any>(
        session.agentId,
        'controlLoginPage',
        payload,
        { timeoutMs: 20_000 }
      );

      const current = this.sessions.get(accountId);
      if (current !== session || current.mode !== 'agent' || current.cancelled) return;

      if (ws.readyState === WebSocket.OPEN && typeof result?.image === 'string' && result.image) {
        ws.send(JSON.stringify({ type: 'screenshot', accountId, image: result.image }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendControlError(message);
    }
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

    console.log(`[LoginManager] 开始登录会话 account=${account.name} accountId=${accountId}`);

    const startedViaAgent = await this.startLoginViaAgent({ accountId, account, ws, user }).catch((error) => {
      console.warn(`[LoginManager] Agent 登录预启动失败 accountId=${accountId}:`, error);
      return false;
    });
    if (startedViaAgent) {
      return;
    }

    ws.send(JSON.stringify({
      type: 'error',
      message: '未找到可用在线 Agent，登录已禁用本地回退；请先绑定并连接 Agent 后重试。',
    }));
  }

  private async captureAndCheck(session: Extract<LoginSession, { mode: 'local' }>): Promise<void> {
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
      console.error('[LoginManager] 截图/登录检测失败:', error);
    } finally {
      session.isCapturing = false;
    }
  }

  private async startLoginViaAgent(options: {
    accountId: string;
    account: any;
    ws: WebSocket;
    user: WsUser;
  }): Promise<boolean> {
    const accountId = options.accountId;
    const account = options.account;
    const ws = options.ws;
    const user = options.user;

    const explicitAgentId = String(account?.agentId || '').trim();
    const preferredAgentId =
      !explicitAgentId && account?.userId
        ? String(
            (await (prisma as any).systemUser.findUnique({
              where: { id: account.userId },
              select: { preferredAgentId: true },
            }))?.preferredAgentId || ''
          ).trim()
        : '';

    const agentId = explicitAgentId || preferredAgentId;
    if (!agentId) return false;
    if (!agentHub.isConnected(agentId)) return false;

    if (user.role === 'operator' && !agentHub.isOwnedBy(agentId, user.id)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Forbidden agent' }));
      return true;
    }

    const session: LoginSession = { mode: 'agent', accountId, agentId, ws, cancelled: false };
    this.sessions.set(accountId, session);
    ws.send(JSON.stringify({ type: 'login_started', accountId, mode: 'agent' }));

    void (async () => {
      try {
        const result = await agentHub.call<any>(
          agentId,
          'loginTaobao',
          { accountId },
          {
            timeoutMs: 12 * 60 * 1000,
            onProgress: (_p, log) => {
              if (!log) return;
              const current = this.sessions.get(accountId);
              if (current !== session) return;
              if (current.mode !== 'agent' || current.cancelled) return;

              let evt: any;
              try {
                evt = JSON.parse(log);
              } catch {
                return;
              }

              if (evt?.type === 'screenshot' && typeof evt?.image === 'string') {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'screenshot', accountId, image: evt.image }));
                }
                return;
              }

              if (evt?.type === 'login_qr' && (typeof evt?.qrUrl === 'string' || typeof evt?.qrImage === 'string')) {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'login_qr',
                      accountId,
                      ...(typeof evt?.qrUrl === 'string' ? { qrUrl: evt.qrUrl } : {}),
                      ...(typeof evt?.qrImage === 'string' ? { qrImage: evt.qrImage } : {}),
                    })
                  );
                }
                return;
              }

              if (evt?.type === 'login_fallback' && typeof evt?.reason === 'string') {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'login_fallback', accountId, reason: evt.reason }));
                }
                return;
              }

              if (evt?.type === 'login_verify_required' && typeof evt?.reason === 'string') {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'login_verify_required', accountId, reason: evt.reason }));
                }
              }
            },
          }
        );

        const current = this.sessions.get(accountId);
        if (current !== session) return;
        if (current.mode !== 'agent' || current.cancelled) return;

        const cookiesJson = String(result?.cookies || '').trim();
        if (!cookiesJson) {
          throw new Error('Agent returned empty cookies');
        }

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

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'login_success', accountId, message: '登录成功' }));
        }
      } catch (err) {
        const current = this.sessions.get(accountId);
        if (current !== session) return;
        if (current.mode !== 'agent' || current.cancelled) return;

        const msg = err instanceof Error ? err.message : String(err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: msg }));
        }
      } finally {
        const current = this.sessions.get(accountId);
        if (current === session) {
          this.sessions.delete(accountId);
        }
      }
    })();

    return true;
  }

  async cancelLoginSession(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;

    console.log(`[LoginManager] 取消登录会话 accountId=${accountId}`);

    if (session.mode === 'local') {
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
    } else {
      session.cancelled = true;
      await agentHub
        .call(session.agentId, 'cancelLoginTaobao', { accountId }, { timeoutMs: 8_000 })
        .catch(() => {});
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
