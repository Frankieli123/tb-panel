import { Page, BrowserContext } from 'playwright';
import { chromeLauncher } from './chromeLauncher.js';
import { HumanSimulator } from './humanSimulator.js';
import { decryptCookies } from '../utils/helpers.js';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  human: HumanSimulator;
  accountId: string;
  cookieSig: string;
  lastUsedAt: number;
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
    return `${s.length}:${s.slice(0, 64)}`;
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
          console.log(`[SharedBrowser] Session invalid for account=${accountId}, recreating`);
          await this.disposeSession(accountId);
        } else if (sig && sig !== existing.cookieSig) {
          console.log(`[SharedBrowser] Cookies changed for account=${accountId}, recreating`);
          await this.disposeSession(accountId);
        } else {
          existing.lastUsedAt = Date.now();
          console.log(`[SharedBrowser] Reusing session for account=${accountId}`);
          return existing;
        }
      }

      // 创建新会话
      console.log(`[SharedBrowser] Creating new session for account=${accountId}`);
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
          console.warn('[SharedBrowser] Failed to inject cookies:', e);
        });
      }

      const page = await context.newPage();
      const human = new HumanSimulator(page);

      const session: BrowserSession = {
        context,
        page,
        human,
        accountId,
        cookieSig: sig,
        lastUsedAt: Date.now(),
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
      await session.context.close().catch(() => {});
    } catch {}

    console.log(`[SharedBrowser] Session closed for account=${accountId}`);
  }

  hasSession(accountId: string): boolean {
    return this.sessions.has(accountId);
  }

  getSession(accountId: string): BrowserSession | undefined {
    return this.sessions.get(accountId);
  }

  listSessionSummaries(): Array<{ accountId: string; lastUsedAt: number; pageClosed: boolean; url: string | null }> {
    return Array.from(this.sessions.values()).map((session) => {
      const pageClosed = session.page.isClosed();
      let url: string | null = null;
      if (!pageClosed) {
        try {
          url = session.page.url();
        } catch {
          url = null;
        }
      }

      return {
        accountId: session.accountId,
        lastUsedAt: session.lastUsedAt,
        pageClosed,
        url,
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
