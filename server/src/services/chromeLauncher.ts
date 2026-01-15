import { spawn, ChildProcess } from 'child_process';
import { createWriteStream, existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { chromium, Browser } from 'playwright';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

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

  private getChromeForTestingMirrorBases(): string[] {
    const raw = String(
      process.env.CHROME_FOR_TESTING_MIRROR_BASES ?? process.env.CHROME_FOR_TESTING_MIRROR_BASE ?? ''
    ).trim();

    const defaults = ['https://registry.npmmirror.com/-/binary/chrome-for-testing'];
    const parts = raw
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : defaults;

    const unique: string[] = [];
    for (const p of parts) {
      const normalized = p.replace(/\/+$/, '');
      if (!normalized) continue;
      if (!unique.includes(normalized)) unique.push(normalized);
    }
    return unique.length > 0 ? unique : defaults;
  }

  private async fetchWithTimeout(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const timeoutMs = Math.max(1_000, Number(init?.timeoutMs ?? 20_000));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    (t as any).unref?.();
    try {
      const { timeoutMs: _ignored, ...rest } = init ?? {};
      return await fetch(url, { ...rest, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  private compareDottedVersion(a: string, b: string): number {
    const pa = a.split('.').map((x) => Number.parseInt(x, 10));
    const pb = b.split('.').map((x) => Number.parseInt(x, 10));
    const n = Math.max(pa.length, pb.length, 4);
    for (let i = 0; i < n; i++) {
      const da = Number.isFinite(pa[i]) ? pa[i] : 0;
      const db = Number.isFinite(pb[i]) ? pb[i] : 0;
      if (da < db) return -1;
      if (da > db) return 1;
    }
    return 0;
  }

  private async resolveChromeForTestingStableDownload(): Promise<{ version: string; url: string } | null> {
    const metaUrl =
      String(process.env.CHROME_FOR_TESTING_METADATA_URL || '').trim() ||
      'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

    const res = await this.fetchWithTimeout(metaUrl, { redirect: 'follow', timeoutMs: 12_000 });
    if (!res.ok) {
      throw new Error(`Failed to fetch Chrome for Testing metadata: HTTP ${res.status}`);
    }

    const data: any = await res.json();
    const version = String(data?.channels?.Stable?.version || '').trim();
    const downloads = data?.channels?.Stable?.downloads?.chrome;
    const found = Array.isArray(downloads) ? downloads.find((d: any) => d?.platform === 'win64') : null;
    const dlUrl = found?.url ? String(found.url) : '';
    if (!version || !dlUrl) return null;
    return { version, url: dlUrl };
  }

  private async resolveChromeForTestingLatestVersionFromMirror(): Promise<string> {
    const bases = this.getChromeForTestingMirrorBases();
    const errors: string[] = [];

    for (const base of bases) {
      const listUrl = `${base}/`;
      try {
        const res = await this.fetchWithTimeout(listUrl, { redirect: 'follow', timeoutMs: 12_000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const raw = (await res.json()) as Array<any>;
        if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty list');

        const versions = raw
          .map((x) => String(x?.name || '').trim())
          .map((s) => s.replace(/\/+$/, ''))
          .filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));

        if (versions.length === 0) throw new Error('No version directories');

        versions.sort((a, b) => this.compareDottedVersion(a, b));
        return versions[versions.length - 1];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${base}: ${msg}`);
      }
    }

    throw new Error(`Failed to resolve Chrome for Testing version from mirrors: ${errors.join('; ')}`);
  }

  private buildChromeForTestingMirrorUrl(base: string, version: string): string {
    const normalizedBase = String(base || '').trim().replace(/\/+$/, '');
    return `${normalizedBase}/${encodeURIComponent(version)}/win64/chrome-win64.zip`;
  }

  private async resolveChromeForTestingDownloadUrls(): Promise<{ version: string; urls: string[] }> {
    const pinnedVersion = String(process.env.CHROME_FOR_TESTING_VERSION || '').trim();
    const explicitUrl = String(process.env.CHROME_FOR_TESTING_DOWNLOAD_URL || '').trim();

    let version = pinnedVersion;
    let officialUrl = '';

    if (!explicitUrl && !version) {
      try {
        const stable = await this.resolveChromeForTestingStableDownload();
        if (stable) {
          version = stable.version;
          officialUrl = stable.url;
        }
      } catch {}
    }

    if (!version) {
      version = await this.resolveChromeForTestingLatestVersionFromMirror();
    }

    const urls: string[] = [];
    if (explicitUrl) urls.push(explicitUrl);
    if (officialUrl) urls.push(officialUrl);

    for (const base of this.getChromeForTestingMirrorBases()) {
      urls.push(this.buildChromeForTestingMirrorUrl(base, version));
    }

    const unique: string[] = [];
    for (const u of urls) {
      const trimmed = String(u || '').trim();
      if (!trimmed) continue;
      if (!unique.includes(trimmed)) unique.push(trimmed);
    }

    return { version, urls: unique };
  }

  private async downloadToFile(url: string, filePath: string): Promise<void> {
    const res = await this.fetchWithTimeout(url, { redirect: 'follow', timeoutMs: 120_000 });
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }
    if (!res.body) {
      throw new Error('Download failed: empty body');
    }
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(filePath));
  }

  private async downloadToFileWithFallback(urls: string[], filePath: string): Promise<string> {
    const errors: string[] = [];
    for (const url of urls) {
      try {
        await this.downloadToFile(url, filePath);
        return url;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${url}: ${msg}`);
      }
    }
    throw new Error(`All download URLs failed: ${errors.join('; ')}`);
  }

  private async ensureChromeForTestingInstalled(): Promise<string | null> {
    if (process.platform !== 'win32') return null;

    const dir = this.getChromeForTestingDir();
    const exePath = this.getChromeForTestingExePath(dir);
    if (existsSync(exePath)) return exePath;

    if (this.installingChrome) return this.installingChrome;

    this.installingChrome = (async () => {
      await mkdir(dir, { recursive: true });

      console.log('[ChromeLauncher] 未找到 Chrome，正在自动安装 Chrome for Testing...');

      const { version, urls } = await this.resolveChromeForTestingDownloadUrls();
      console.log(`[ChromeLauncher] 已解析 Chrome for Testing 版本: ${version}`);
      console.log(`[ChromeLauncher] 下载候选: ${urls.join(' | ')}`);

      const zipPath = path.join(dir, 'chrome-win64.zip');
      const tmpZipPath = `${zipPath}.tmp`;
      const extractedDir = path.join(dir, 'chrome-win64');

      await rm(tmpZipPath, { force: true }).catch(() => {});
      await rm(zipPath, { force: true }).catch(() => {});
      await rm(extractedDir, { recursive: true, force: true }).catch(() => {});

      const used = await this.downloadToFileWithFallback(urls, tmpZipPath);
      console.log(`[ChromeLauncher] 已从以下地址下载: ${used}`);
      await this.expandZipWithPowerShell(tmpZipPath, dir);
      await rm(tmpZipPath, { force: true }).catch(() => {});

      if (!existsSync(exePath)) {
        throw new Error(`Chrome for Testing install failed: ${exePath} not found`);
      }

      console.log(`[ChromeLauncher] Chrome for Testing 已安装到: ${exePath}`);
      return exePath;
    })()
      .catch((err) => {
        console.warn('[ChromeLauncher] 自动安装失败:', err);
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
  async ensureChromeAvailable(): Promise<string | null> {
    const existing = this.findChromePath();
    if (existing) return existing;
    if (!this.autoInstallChrome) return null;
    return await this.ensureChromeForTestingInstalled();
  }

  async launch(): Promise<Browser> {
    // 检查现有浏览器是否仍然健康
    if (this.browser) {
      try {
        // 尝试获取 contexts 来验证连接是否有效
        this.browser.contexts();
        console.log('[ChromeLauncher] 浏览器已在运行，复用连接');
        return this.browser;
      } catch (e) {
        console.log('[ChromeLauncher] 现有浏览器连接无效，正在重启...');
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
      console.log('[ChromeLauncher] 已连接到现有 Chrome 实例');
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

    console.log(`[ChromeLauncher] 找到 Chrome: ${chromePath}`);
    console.log(`[ChromeLauncher] 使用用户数据目录: ${this.userDataDir}`);

    const args = [
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
    ];

    const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    if (process.platform !== 'win32' && !hasDisplay) {
      args.push('--headless=new');
    }

    try {
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        args.push('--no-sandbox', '--disable-setuid-sandbox');
      }
    } catch {}

    // 启动 Chrome 进程
    this.chromeProcess = spawn(chromePath, args, {
      detached: false,
      stdio: 'ignore'
    });

    this.chromeProcess.on('error', (err) => {
      console.error('[ChromeLauncher] Chrome 进程错误:', err);
    });

    this.chromeProcess.on('exit', (code) => {
      console.log(`[ChromeLauncher] Chrome 进程退出 code=${code}`);
      this.chromeProcess = null;
      this.browser = null;
    });

    // 轮询连接替代固定等待
    let connected = false;
    for (let i = 0; i < 30; i++) {
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.debugPort}`);
        connected = true;
        console.log('[ChromeLauncher] 已通过 CDP 连接到 Chrome');
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
    console.log('[ChromeLauncher] 正在关闭 Chrome...');

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        console.warn('[ChromeLauncher] 关闭浏览器失败:', error);
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
        console.warn('[ChromeLauncher] 结束 Chrome 进程失败:', error);
      }
      this.chromeProcess = null;
    }

    console.log('[ChromeLauncher] Chrome 已关闭');
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
