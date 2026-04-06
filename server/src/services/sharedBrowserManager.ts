import { Page, BrowserContext } from 'playwright';
import { createHash } from 'crypto';
import { chromeLauncher } from './chromeLauncher.js';
import { HumanSimulator } from './humanSimulator.js';
import { decryptCookies } from '../utils/helpers.js';
import type { CartSkuSnapshot } from './cartSnapshot.js';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  detailPage?: Page | null;
  human: HumanSimulator;
  accountId: string;
  cookieSig: string;
  lastUsedAt: number;
  lastCartRefreshAt?: number;
  lastCartSnapshot?: CartSkuSnapshot | null;
  cartReloadCount: number;
  fullCartScanCount: number;
  detailPageOpenCount: number;
}

class SharedBrowserManager {
  private sessions = new Map<string, BrowserSession>();
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

  private cookieSignature(input?: string): string {
    if (!input) return '';
    const s = String(input);
    const hash = createHash('sha256').update(s).digest('hex').slice(0, 16);
    return `${s.length}:${hash}`;
  }

  private parseCookies(input?: string): any[] | null {
    if (!input) return null;
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
    try {
      const decrypted = decryptCookies(input);
      const parsed = JSON.parse(decrypted);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async getOrCreateSession(accountId: string, cookies?: string): Promise<BrowserSession> {
    return this.runExclusive(async () => {
      const sig = this.cookieSignature(cookies);
      const existing = this.sessions.get(accountId);

      if (existing) {
        let pageValid = false;
        try {
          pageValid = !existing.page.isClosed();
          if (pageValid) {
            await existing.page.evaluate(() => true);
          }
        } catch {
          pageValid = false;
        }

        if (!pageValid) {
          console.log(`[SharedBrowser] 会话已失效 accountId=${accountId}，重建中`);
          await this.disposeSession(accountId);
        } else if (sig && sig !== existing.cookieSig) {
          console.log(`[SharedBrowser] Cookie 已变化 accountId=${accountId}，重建中`);
          await this.disposeSession(accountId);
        } else {
          if (existing.detailPage?.isClosed()) {
            existing.detailPage = null;
          }
          existing.lastUsedAt = Date.now();
          console.log(`[SharedBrowser] 复用会话 accountId=${accountId}`);
          return existing;
        }
      }

      // 创建新会话
      console.log(`[SharedBrowser] 创建新会话 accountId=${accountId}`);
      const realChrome = await chromeLauncher.launch();

      const context = await realChrome.newContext({
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
          console.warn('[SharedBrowser] 注入 Cookie 失败:', e);
        });
      }

      const page = await context.newPage();
      const human = new HumanSimulator(page);

      const session: BrowserSession = {
        context,
        page,
        detailPage: null,
        human,
        accountId,
        cookieSig: sig,
        lastUsedAt: Date.now(),
        lastCartRefreshAt: 0,
        lastCartSnapshot: null,
        cartReloadCount: 0,
        fullCartScanCount: 0,
        detailPageOpenCount: 0,
      };

      this.sessions.set(accountId, session);
      return session;
    });
  }

  async disposeSession(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;
    this.sessions.delete(accountId);

    try {
      await session.page.close().catch(() => {});
    } catch {}
    try {
      if (session.detailPage && session.detailPage !== session.page && !session.detailPage.isClosed()) {
        await session.detailPage.close().catch(() => {});
      }
    } catch {}
    try {
      await session.context.close().catch(() => {});
    } catch {}

    console.log(`[SharedBrowser] 会话已关闭 accountId=${accountId}`);
  }

  hasSession(accountId: string): boolean {
    return this.sessions.has(accountId);
  }

  getSession(accountId: string): BrowserSession | undefined {
    return this.sessions.get(accountId);
  }

  listSessionSummaries(): Array<{
    accountId: string;
    lastUsedAt: number;
    pageClosed: boolean;
    url: string | null;
    detailUrl: string | null;
    lastCartRefreshAt: number;
    cartReloadCount: number;
    fullCartScanCount: number;
    detailPageOpenCount: number;
  }> {
    return Array.from(this.sessions.values()).map((session) => {
      const pageClosed = session.page.isClosed();
      let url: string | null = null;
      let detailUrl: string | null = null;
      if (!pageClosed) {
        try {
          url = session.page.url();
        } catch {
          url = null;
        }
      }
      if (session.detailPage && !session.detailPage.isClosed()) {
        try {
          detailUrl = session.detailPage.url();
        } catch {
          detailUrl = null;
        }
      }

      return {
        accountId: session.accountId,
        lastUsedAt: session.lastUsedAt,
        pageClosed,
        url,
        detailUrl,
        lastCartRefreshAt: Math.max(0, Math.floor(session.lastCartRefreshAt ?? 0)),
        cartReloadCount: Math.max(0, Math.floor(session.cartReloadCount ?? 0)),
        fullCartScanCount: Math.max(0, Math.floor(session.fullCartScanCount ?? 0)),
        detailPageOpenCount: Math.max(0, Math.floor(session.detailPageOpenCount ?? 0)),
      };
    });
  }

  updateLastUsed(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (session) {
      session.lastUsedAt = Date.now();
    }
  }
}

export const sharedBrowserManager = new SharedBrowserManager();
