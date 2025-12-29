import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import { chromium, Browser } from 'playwright';

/**
 * Chrome 启动管理器
 * 自动启动独立的 Chrome 实例用于自动化，与用户正在使用的窗口完全隔离
 */
export class ChromeLauncher {
  private chromeProcess: ChildProcess | null = null;
  private browser: Browser | null = null;
  private readonly debugPort = 9222;
  private readonly userDataDir: string;

  constructor() {
    this.userDataDir = path.join(process.cwd(), 'data', 'chrome-automation');
  }

  /**
   * 启动独立的 Chrome 实例
   */
  async launch(): Promise<Browser> {
    // 检查现有浏览器是否仍然健康
    if (this.browser) {
      try {
        // 尝试获取 contexts 来验证连接是否有效
        this.browser.contexts();
        console.log('[ChromeLauncher] Browser already running, reusing connection');
        return this.browser;
      } catch (e) {
        console.log('[ChromeLauncher] Existing browser connection invalid, restarting...');
        this.browser = null;
        // 杀掉旧进程
        if (this.chromeProcess) {
          try {
            this.chromeProcess.kill('SIGTERM');
          } catch {}
          this.chromeProcess = null;
        }
      }
    }

    // 尝试连接到已有的 Chrome 实例（可能是之前启动但引用丢失的）
    try {
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.debugPort}`);
      console.log('[ChromeLauncher] Connected to existing Chrome instance');
      return this.browser;
    } catch {
      // 没有现有实例，继续启动新的
    }

    // 确保用户数据目录存在
    await mkdir(this.userDataDir, { recursive: true });

    // 检测 Chrome 安装路径
    const chromePath = this.findChromePath();
    if (!chromePath) {
      throw new Error('Chrome/Chromium not found. Please install Google Chrome or Chromium.');
    }

    console.log(`[ChromeLauncher] Found Chrome at: ${chromePath}`);
    console.log(`[ChromeLauncher] Using profile: ${this.userDataDir}`);

    // 启动 Chrome 进程
    this.chromeProcess = spawn(chromePath, [
      `--remote-debugging-port=${this.debugPort}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-startup-window',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ], {
      detached: false,
      stdio: 'ignore'
    });

    this.chromeProcess.on('error', (err) => {
      console.error('[ChromeLauncher] Chrome process error:', err);
    });

    this.chromeProcess.on('exit', (code) => {
      console.log(`[ChromeLauncher] Chrome process exited with code ${code}`);
      this.chromeProcess = null;
      this.browser = null;
    });

    // 轮询连接替代固定等待
    let connected = false;
    for (let i = 0; i < 30; i++) {
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.debugPort}`);
        connected = true;
        console.log('[ChromeLauncher] Connected to Chrome via CDP');
        break;
      } catch {
        await this.sleep(300);
      }
    }

    if (!connected || !this.browser) {
      this.kill();
      throw new Error('Failed to connect to Chrome. Please ensure Chrome is properly installed.');
    }

    // 关闭默认打开的空白页面
    try {
      const contexts = this.browser.contexts();
      for (const ctx of contexts) {
        const pages = ctx.pages();
        for (const page of pages) {
          const url = page.url();
          if (url === 'about:blank' || url.startsWith('chrome://')) {
            await page.close().catch(() => {});
          }
        }
      }
    } catch {}

    return this.browser;
  }

  /**
   * 获取浏览器实例（如果已启动）
   */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /**
   * 关闭 Chrome 实例
   */
  async kill(): Promise<void> {
    console.log('[ChromeLauncher] Shutting down Chrome...');

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        console.warn('[ChromeLauncher] Error closing browser:', error);
      }
      this.browser = null;
    }

    if (this.chromeProcess) {
      try {
        this.chromeProcess.kill('SIGTERM');
        await this.sleep(2000);

        if (!this.chromeProcess.killed) {
          this.chromeProcess.kill('SIGKILL');
        }
      } catch (error) {
        console.warn('[ChromeLauncher] Error killing Chrome process:', error);
      }
      this.chromeProcess = null;
    }

    console.log('[ChromeLauncher] Chrome shutdown complete');
  }

  /**
   * 检测系统中的 Chrome 安装路径
   */
  private findChromePath(): string | null {
    const platform = process.platform;
    const possiblePaths: string[] = [];

    if (platform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
        'C:\\Program Files\\Chromium\\Application\\chrome.exe'
      );
    } else if (platform === 'darwin') {
      possiblePaths.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      );
    } else {
      // Linux
      possiblePaths.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium'
      );
    }

    for (const chromePath of possiblePaths) {
      if (existsSync(chromePath)) {
        return chromePath;
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 单例实例
export const chromeLauncher = new ChromeLauncher();
