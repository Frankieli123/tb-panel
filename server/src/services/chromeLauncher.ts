import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
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
  private readonly autoInstallChrome: boolean;
  private installingChrome: Promise<string | null> | null = null;

  constructor() {
    this.userDataDir = this.resolveUserDataDir();
    this.autoInstallChrome = /^(1|true)$/i.test(String(process.env.CHROME_AUTO_INSTALL ?? ''));
  }

  private resolveUserDataDir(): string {
    const explicit = String(process.env.CHROME_USER_DATA_DIR || '').trim();
    if (explicit) return explicit;

    const agentHome = String(process.env.TAOBAO_AGENT_HOME || '').trim();
    if (agentHome) return path.join(agentHome, 'chrome-profile');

    return path.join(process.cwd(), 'data', 'chrome-automation');
  }

  private getAgentStoreDir(): string {
    const explicit = String(process.env.TAOBAO_AGENT_HOME || '').trim();
    if (explicit) return explicit;

    const base =
      String(process.env.PROGRAMDATA || '').trim() ||
      String(process.env.APPDATA || '').trim() ||
      os.homedir();

    return path.join(base, 'TaobaoAgent');
  }

  private getChromeForTestingDir(): string {
    const explicit = String(process.env.CHROME_FOR_TESTING_DIR || '').trim();
    if (explicit) return explicit;
    return path.join(this.getAgentStoreDir(), 'chrome-for-testing');
  }

  private getChromeForTestingExePath(dir: string): string {
    // Currently only auto-install on Windows (agent MSI use-case)
    return path.join(dir, 'chrome-win64', 'chrome.exe');
  }

  private escapePsSingleQuoted(input: string): string {
    return input.replace(/'/g, "''");
  }

  private async expandZipWithPowerShell(zipPath: string, destDir: string): Promise<void> {
    const z = this.escapePsSingleQuoted(zipPath);
    const d = this.escapePsSingleQuoted(destDir);

    await new Promise<void>((resolve, reject) => {
      const ps = spawn(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath '${z}' -DestinationPath '${d}' -Force`,
        ],
        { stdio: 'ignore' }
      );

      ps.on('error', reject);
      ps.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Expand-Archive failed (exit ${code ?? 'unknown'})`));
      });
    });
  }

  private async resolveChromeForTestingDownloadUrl(): Promise<string> {
    const url = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`Failed to fetch Chrome for Testing metadata: HTTP ${res.status}`);
    }

    const data: any = await res.json();
    const downloads = data?.channels?.Stable?.downloads?.chrome;
    const found = Array.isArray(downloads) ? downloads.find((d: any) => d?.platform === 'win64') : null;
    const dlUrl = found?.url ? String(found.url) : '';
    if (!dlUrl) {
      throw new Error('Chrome for Testing download URL not found (Stable/win64)');
    }

    return dlUrl;
  }

  private async downloadToFile(url: string, filePath: string): Promise<void> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(filePath, buf);
  }

  private async ensureChromeForTestingInstalled(): Promise<string | null> {
    if (process.platform !== 'win32') return null;

    const dir = this.getChromeForTestingDir();
    const exePath = this.getChromeForTestingExePath(dir);
    if (existsSync(exePath)) return exePath;

    if (this.installingChrome) return this.installingChrome;

    this.installingChrome = (async () => {
      await mkdir(dir, { recursive: true });

      const dlUrl = await this.resolveChromeForTestingDownloadUrl();
      console.log('[ChromeLauncher] Chrome not found. Auto-installing Chrome for Testing...');
      console.log(`[ChromeLauncher] Downloading: ${dlUrl}`);

      const zipPath = path.join(dir, 'chrome-win64.zip');
      const tmpZipPath = `${zipPath}.tmp`;
      const extractedDir = path.join(dir, 'chrome-win64');

      await rm(tmpZipPath, { force: true }).catch(() => {});
      await rm(zipPath, { force: true }).catch(() => {});
      await rm(extractedDir, { recursive: true, force: true }).catch(() => {});

      await this.downloadToFile(dlUrl, tmpZipPath);
      await this.expandZipWithPowerShell(tmpZipPath, dir);
      await rm(tmpZipPath, { force: true }).catch(() => {});

      if (!existsSync(exePath)) {
        throw new Error(`Chrome for Testing install failed: ${exePath} not found`);
      }

      console.log(`[ChromeLauncher] Chrome for Testing installed at: ${exePath}`);
      return exePath;
    })()
      .catch((err) => {
        console.warn('[ChromeLauncher] Auto-install failed:', err);
        return null;
      })
      .finally(() => {
        this.installingChrome = null;
      });

    return this.installingChrome;
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
    let chromePath = this.findChromePath();

    if (!chromePath && this.autoInstallChrome) {
      chromePath = await this.ensureChromeForTestingInstalled();
    }

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
    const envPath = String(process.env.CHROME_PATH || process.env.CHROME_EXECUTABLE_PATH || '').trim();
    if (envPath && existsSync(envPath)) return envPath;

    const cftExe = this.getChromeForTestingExePath(this.getChromeForTestingDir());
    if (existsSync(cftExe)) return cftExe;

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
