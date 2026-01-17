import { Worker, Job } from 'bullmq';
import { PrismaClient, AccountStatus } from '@prisma/client';
import { scraper, ScrapeResult } from './scraper.js';
import { cartScraper } from './cartScraper.js';
import { agentHub } from './agentHub.js';
import { autoCartAdder } from './autoCartAdder.js';
import { requestPauseForAddWithTimeout, resumeAdd } from './accountTaskControl.js';
import { setHumanDelayScale } from './humanSimulator.js';
import { notificationService } from './notification.js';
import { randomDelay, sleep, calculatePriceDrop, encryptCookies } from '../utils/helpers.js';
import { taskQueue, taskQueueConnection } from './taskQueue.js';
import { getCartSkuStats, setCartSkuStats } from './cartSkuStats.js';

const prisma = new PrismaClient();

const CART_BASE_SKU_ID = '__BASE__';
const CART_ADD_JOB_NAMES = new Set(['cart-add', 'cart-batch-add']);
const CART_SKU_SOFT_LIMIT = 280;
const CART_SKU_HARD_LIMIT = 300;

type CartAddQueueStats = {
  total: number;
  waiting: number;
  prioritized: number;
  active: number;
  delayed: number;
};

function toJobIdText(jobId: unknown): string {
  const text = String(jobId ?? '').trim();
  return text || 'n/a';
}

function countCartAddJobs(jobs: Job[]): number {
  let n = 0;
  for (const j of jobs) {
    if (CART_ADD_JOB_NAMES.has(j.name)) n++;
  }
  return n;
}

async function getCartAddQueueStats(): Promise<CartAddQueueStats> {
  const [waitingJobs, prioritizedJobs, activeJobs, delayedJobs] = await Promise.all([
    taskQueue.getJobs(['waiting'], 0, -1),
    taskQueue.getJobs(['prioritized'], 0, -1),
    taskQueue.getJobs(['active'], 0, -1),
    taskQueue.getJobs(['delayed'], 0, -1),
  ]);

  const waiting = countCartAddJobs(waitingJobs);
  const prioritized = countCartAddJobs(prioritizedJobs);
  const active = countCartAddJobs(activeJobs);
  const delayed = countCartAddJobs(delayedJobs);
  return {
    total: waiting + prioritized + active + delayed,
    waiting,
    prioritized,
    active,
    delayed,
  };
}

function formatCartAddQueueStats(stats: CartAddQueueStats): string {
  const queued = stats.waiting + stats.prioritized;
  return `加购任务队列: 总=${stats.total} (执行中=${stats.active} 等待=${queued} 延迟=${stats.delayed})`;
}

function isDigits(input: string): boolean {
  return /^\d+$/.test(String(input || '').trim());
}

function normalizeSkuProperties(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  const normalized = raw
    .replace(/[；]/g, ';')
    .replace(/[：]/g, ':')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*/g, ';')
    .trim();

  const pairs: Array<{ label: string; value: string }> = [];
  const pairRe = /([^:;\s]+)\s*:\s*([^;]+?)(?=\s+[^:;\s]+\s*:|;|$)/g;
  for (const match of normalized.matchAll(pairRe)) {
    const label = String(match[1] ?? '').trim();
    const value = String(match[2] ?? '').trim();
    if (!label || !value) continue;
    pairs.push({ label, value });
  }

  if (pairs.length === 0) return normalized;
  pairs.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  return pairs.map((p) => `${p.label}:${p.value}`).join(';');
}

// 任务队列（BullMQ）

// 账号调度状态
interface AccountScheduleState {
  accountId: string;
  lastRunAt: number;
  isRunning: boolean;
  productQueue: string[]; // 待抓取的商品ID列表
}

class SchedulerService {
  private accountStates: Map<string, AccountScheduleState> = new Map();
  private worker: Worker | null = null;
  private isRunning = false;
  private mainLoopInterval: NodeJS.Timeout | null = null;
  private riskPauseUntilMs = 0;
  private riskStreak = 0;
  private isQuietPaused = false;

  private isRiskPaused(nowMs: number): boolean {
    return nowMs < this.riskPauseUntilMs;
  }

  private parseTimeToMinutes(value: unknown): number | null {
    const text = String(value ?? '').trim();
    if (!/^\d{2}:\d{2}$/.test(text)) return null;
    const [hhRaw, mmRaw] = text.split(':');
    const hh = parseInt(hhRaw, 10);
    const mm = parseInt(mmRaw, 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  private isWithinQuietHours(now: Date, scraperConfig: any): boolean {
    if (!scraperConfig?.quietHoursEnabled) return false;

    const startMin = this.parseTimeToMinutes(scraperConfig?.quietHoursStart);
    const endMin = this.parseTimeToMinutes(scraperConfig?.quietHoursEnd);
    if (startMin === null || endMin === null || startMin === endMin) return false;

    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
    return nowMin >= startMin || nowMin < endMin;
  }

  private clearRiskPause(): void {
    this.riskPauseUntilMs = 0;
    this.riskStreak = 0;
  }

  private setRiskPause(nowMs: number): number {
    this.riskStreak += 1;
    const baseMs = 5 * 60 * 1000;
    const maxMs = 60 * 60 * 1000;
    const pauseMs = Math.min(baseMs * Math.pow(2, this.riskStreak - 1), maxMs);
    this.riskPauseUntilMs = nowMs + pauseMs;
    return pauseMs;
  }

  private async resolveAgentIdForAccount(
    account: { agentId: string | null; userId: string | null },
    ownerUserId: string | null
  ): Promise<string | null> {
    const boundAgentId = account.agentId ? String(account.agentId).trim() : '';

    // 账号已绑定 Agent：只允许使用该 Agent（在线才返回；不在线不回退到其他 Agent）
    if (boundAgentId) {
      return agentHub.isConnected(boundAgentId) ? boundAgentId : null;
    }

    const contextUserIdRaw = ownerUserId
      ? String(ownerUserId).trim()
      : account.userId
        ? String(account.userId).trim()
        : null;
    const contextUserId = contextUserIdRaw || null;

    // With user context, allow preferred agent / any agent owned by that user.
    if (contextUserId) {
      const preferredAgentId =
        (await (prisma as any).systemUser
          .findUnique({
            where: { id: contextUserId },
            select: { preferredAgentId: true },
          })
          .catch(() => null as any))?.preferredAgentId ?? null;

      const preferred = preferredAgentId ? String(preferredAgentId).trim() : '';
      if (preferred && agentHub.isConnected(preferred) && agentHub.isOwnedBy(preferred, contextUserId)) {
        return preferred;
      }

      const fallback =
        agentHub.listConnectedAgents().find((a) => agentHub.isOwnedBy(a.agentId, contextUserId))?.agentId ?? null;
      return fallback ? String(fallback).trim() : null;
    }

    // No user context: do NOT use arbitrary online user agents; only allow system/shared agents.
    const systemAgent =
      agentHub.listConnectedAgents().find((a) => agentHub.isOwnedBy(a.agentId, null))?.agentId ?? null;
    return systemAgent ? String(systemAgent).trim() : null;
  }

  private pickAccountIdFromPool(accountIds: string[], preferredAccountId: string | null): string {
    const ids = Array.from(new Set(accountIds.map((x) => String(x || '').trim()).filter(Boolean)));
    if (ids.length === 0) {
      throw new Error('No active account available');
    }

    const candidates = ids
      .map((id) => {
        const stats = getCartSkuStats(id);
        const total = stats?.cartSkuTotal ?? null;
        return { id, total };
      })
      .filter((c) => c.total === null || c.total < CART_SKU_HARD_LIMIT);

    const preferred = preferredAccountId ? String(preferredAccountId).trim() : '';
    if (preferred) {
      const p = candidates.find((c) => c.id === preferred);
      if (p && (p.total === null || p.total < CART_SKU_SOFT_LIMIT)) {
        return preferred;
      }
    }

    const known = candidates
      .filter((c) => typeof c.total === 'number' && c.total < CART_SKU_SOFT_LIMIT)
      .sort((a, b) => (a.total as number) - (b.total as number));
    if (known.length > 0) return known[0].id;

    const unknown = candidates.find((c) => c.total === null);
    if (unknown) return unknown.id;

    throw new Error(`No account available: cart SKU limit reached (>=${CART_SKU_SOFT_LIMIT})`);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log('[Scheduler] 启动中...');
    // 仅购物车模式：不初始化详情页抓取链路

    // 初始化账号状态
    await this.initAccountStates();

    // 启动任务处理worker
    this.worker = new Worker(
      'scrape-tasks',
      async (job: Job) => {
        return this.processJob(job);
      },
      {
        connection: taskQueueConnection,
        concurrency: 2, // 允许抓价抢占加购（加购会在 Agent 侧按 SKU 边界暂停/恢复）
      }
    );

    this.worker.on('completed', (job) => {
      console.log(`[Scheduler] 任务已完成 jobId=${job.id}`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`[Scheduler] 任务失败 jobId=${job?.id}:`, err.message);
    });

    // 主调度循环
    this.isRunning = true;
    this.mainLoopInterval = setInterval(() => this.scheduleTasks(), 10000); // 每10秒检查一次
    await this.scheduleTasks(); // 立即执行一次

    console.log('[Scheduler] 已启动');
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
      this.mainLoopInterval = null;
    }

    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }

    console.log('[Scheduler] 已停止');
  }

  private async initAccountStates(): Promise<void> {
    const accounts = await prisma.taobaoAccount.findMany({
      where: { isActive: true },
    });

    for (const account of accounts) {
      this.accountStates.set(account.id, {
        accountId: account.id,
        lastRunAt: 0,
        isRunning: false,
        productQueue: [],
      });
    }

    console.log(`[Scheduler] 已初始化 ${accounts.length} 个账号`);
  }

  /**
   * 购物车模式批量抓取调度（仅使用 pollingInterval）
   */
  private async scheduleCartScraping(
    accounts: any[],
    defaultIntervalMs: number,
    nowMs: number
  ): Promise<void> {
    try {
      for (const account of accounts) {
        const baseCount = await prisma.product.count({
          where: {
            ownerAccountId: account.id,
            monitorMode: 'CART',
            skuId: CART_BASE_SKU_ID,
            isActive: true
          }
        });

        const cartProductsCount =
          baseCount > 0
            ? baseCount
            : await prisma.product.count({
                where: {
                  ownerAccountId: account.id,
                  monitorMode: 'CART',
                  isActive: true
                }
              });

        if (cartProductsCount === 0) continue;

        const sampleProduct = await prisma.product.findFirst({
          where: {
            ownerAccountId: account.id,
            monitorMode: 'CART',
            ...(baseCount > 0 ? { skuId: CART_BASE_SKU_ID } : {}),
            isActive: true
          },
          orderBy: { lastCheckAt: 'asc' }
        });

        if (!sampleProduct) continue;

        // 到达轮询间隔才入队
        if (sampleProduct.lastCheckAt) {
          const timeSinceLastCheck = nowMs - sampleProduct.lastCheckAt.getTime();
          if (timeSinceLastCheck < defaultIntervalMs) {
            continue;
          }
        }

        // 去重：同一账号同时只允许一个定时 cart-scrape job
        const jobId = `cart_scrape_${account.id}`;

        try {
          const existingJob = await taskQueue.getJob(jobId).catch(() => null);
          if (existingJob) {
            const state = await existingJob.getState().catch(() => null);
            if (state && state !== 'completed' && state !== 'failed') {
              continue;
            }
          }

          await taskQueue.add(
            'cart-scrape',
            {
              accountId: account.id,
              productCount: cartProductsCount
            },
            {
              jobId,
              priority: 5,
              removeOnComplete: true,
              removeOnFail: true,
              attempts: 2,
              backoff: {
                type: 'exponential',
                delay: 30000
              }
            }
          );

          console.log(`[Scheduler] 已安排购物车抓价 accountId=${account.id} products=${cartProductsCount}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 静默跳过已存在的任务（避免日志污染）
          if (!message.toLowerCase().includes('already exists')) {
            console.error(`[Scheduler] 安排购物车抓价失败 accountId=${account.id}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('[Scheduler] 购物车抓价调度出错:', error);
    }
  }

  private async scheduleTasks(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const nowMs = Date.now();
      if (this.isRiskPaused(nowMs)) {
        return;
      }

      // 获取抓取配置
      const scraperConfig = await (prisma as any).scraperConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
      const quietNow = this.isWithinQuietHours(new Date(nowMs), scraperConfig);
      if (quietNow) {
        if (!this.isQuietPaused) {
          console.log(
            `[Scheduler] 静默时间生效（${String(scraperConfig?.quietHoursStart || '')}-${String(scraperConfig?.quietHoursEnd || '')}），跳过调度`
          );
        }
        this.isQuietPaused = true;
        return;
      }
      if (this.isQuietPaused) {
        console.log('[Scheduler] 静默时间结束，恢复调度');
      }
      this.isQuietPaused = false;
      const defaultIntervalMs = (scraperConfig?.pollingInterval ?? 60) * 60 * 1000;

      // 获取所有活跃账号
      const accounts = await prisma.taobaoAccount.findMany({
        where: {
          isActive: true,
          status: { in: [AccountStatus.IDLE, AccountStatus.RUNNING] },
        },
      });

      // ========== 1. 购物车模式批量抓取 ==========
      await this.scheduleCartScraping(accounts, defaultIntervalMs, nowMs);
    } catch (error) {
      console.error('[Scheduler] 调度循环出错(scheduleTasks):', error);
    }
  }

  private async processJob(job: Job): Promise<any> {
    // 判断任务类型
    if (job.name === 'cart-scrape') {
      return this.processCartScrapeJob(job);
    }

    if (job.name === 'cart-remove') {
      return this.processCartRemoveJob(job);
    }

    if (job.name === 'cart-add') {
      return this.processCartAddJob(job);
    }

    if (job.name === 'cart-batch-add') {
      return this.processCartBatchAddJob(job);
    }

    console.log(`[Scheduler] 不支持的任务 name=${job.name} jobId=${job.id}`);
    return { success: false, error: 'Unsupported job' };
  }

  /**
   * 处理购物车批量抓取任务
   */
  private async processCartScrapeJob(job: Job): Promise<{ success: boolean; updated: number; failed: number; missing: number }> {
    const { accountId, productCount } = job.data;

    try {
      const scraperConfig = await (prisma as any).scraperConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
      const force = Boolean((job.data as any)?.force);
      if (!force && this.isWithinQuietHours(new Date(), scraperConfig)) {
        console.log(`[Scheduler] 静默时间生效，跳过购物车抓价 accountId=${accountId} products=${productCount}`);
        return { success: true, updated: 0, failed: 0, missing: 0 };
      }
      console.log(
        `[Scheduler] 购物车抓价开始 accountId=${accountId} products=${productCount}${force ? ' force=1' : ''}`
      );
      const humanDelayScale =
        typeof scraperConfig?.humanDelayScale === 'number' && Number.isFinite(scraperConfig.humanDelayScale)
          ? scraperConfig.humanDelayScale
          : 1;
      setHumanDelayScale(humanDelayScale);

      const cartAddSkuDelayMinMsRaw = Number((scraperConfig as any)?.cartAddSkuDelayMinMs);
      const cartAddSkuDelayMaxMsRaw = Number((scraperConfig as any)?.cartAddSkuDelayMaxMs);
      const cartAddSkuDelayMinMs = Number.isFinite(cartAddSkuDelayMinMsRaw)
        ? Math.max(0, Math.floor(cartAddSkuDelayMinMsRaw))
        : 900;
      const cartAddSkuDelayMaxMs = Number.isFinite(cartAddSkuDelayMaxMsRaw)
        ? Math.max(cartAddSkuDelayMinMs, Math.floor(cartAddSkuDelayMaxMsRaw))
        : 2200;

      const account = await prisma.taobaoAccount.findUnique({
        where: { id: accountId },
        select: { id: true, name: true, cookies: true, agentId: true, userId: true }
      });

      if (!account) {
        throw new Error('Account not found');
      }

      const agentIdToUse = await this.resolveAgentIdForAccount(account, null);
      if (account.agentId && (!agentIdToUse || !agentHub.isConnected(agentIdToUse))) {
        console.warn(
          `[Scheduler] 账号绑定Agent离线，回退到本地抓价 accountId=${accountId} boundAgentId=${String(account.agentId)}`
        );
      }
      console.log(
        `[Scheduler] 购物车抓价执行器 accountId=${accountId} boundAgentId=${account.agentId || 'null'} agentId=${
          agentIdToUse && agentHub.isConnected(agentIdToUse) ? agentIdToUse : 'local'
        }`
      );

      const expectedTaobaoIds = await (async (): Promise<string[]> => {
        const rowsBase = await prisma.product.findMany({
          where: {
            ownerAccountId: accountId,
            monitorMode: 'CART',
            skuId: CART_BASE_SKU_ID,
            isActive: true,
          },
          select: { taobaoId: true },
        });

        const idsBase = Array.from(new Set(rowsBase.map((r) => String(r.taobaoId || '').trim()).filter(Boolean)));
        if (idsBase.length > 0) return idsBase;

        const rowsAll = await prisma.product.findMany({
          where: { ownerAccountId: accountId, monitorMode: 'CART', isActive: true },
          select: { taobaoId: true },
        });

        return Array.from(new Set(rowsAll.map((r) => String(r.taobaoId || '').trim()).filter(Boolean)));
      })();

      const expectedDistinctTaobaoIds =
        expectedTaobaoIds.length > 0 ? expectedTaobaoIds.length : Math.max(0, Number(productCount) || 0);

      const distinctCount = (cart: any): number => {
        if (!cart?.success || !Array.isArray(cart?.products)) return 0;
        const set = new Set<string>();
        for (const p of cart.products) {
          const id = p?.taobaoId ? String(p.taobaoId).trim() : '';
          if (id) set.add(id);
        }
        return set.size;
      };

      const scrapeCart = async (): Promise<any> => {
        if (agentIdToUse && agentHub.isConnected(agentIdToUse)) {
          return agentHub.call<any>(
            agentIdToUse,
            'scrapeCart',
            { accountId, cookies: account.cookies, delayScale: humanDelayScale, expectedTaobaoIds },
            { timeoutMs: 10 * 60 * 1000 }
          );
        }

        return cartScraper.scrapeCart(accountId, account.cookies, { expectedTaobaoIds });
      };

      let cart: any;
      let bestDistinct = 0;

      const pauseTimeoutMs = 20000;
      const pausedUsingAgent = Boolean(agentIdToUse && agentHub.isConnected(agentIdToUse));

      if (pausedUsingAgent && agentIdToUse) {
        await agentHub
          .call<any>(agentIdToUse, 'pauseAddForScrape', { accountId, timeoutMs: pauseTimeoutMs }, { timeoutMs: pauseTimeoutMs + 5000 })
          .catch((err) => {
            console.warn(`[Scheduler] 购物车抓价前暂停加购失败 accountId=${accountId} agentId=${agentIdToUse}:`, err);
          });
      } else {
        await requestPauseForAddWithTimeout(accountId, pauseTimeoutMs).catch(() => {});
      }

      try {
        cart = await scrapeCart();
        bestDistinct = distinctCount(cart);

        if (!cart?.success) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            await sleep(1500);
            const next = await scrapeCart();
            if (next?.success) {
              cart = next;
              bestDistinct = distinctCount(next);
              break;
            }
          }
        } else if (expectedDistinctTaobaoIds > 0 && bestDistinct < expectedDistinctTaobaoIds) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            await sleep(1500);
            const next = await scrapeCart();
            const nextDistinct = distinctCount(next);
            if (nextDistinct > bestDistinct) {
              cart = next;
              bestDistinct = nextDistinct;
            }
            if (bestDistinct >= expectedDistinctTaobaoIds) break;
          }
        }
      } finally {
        if (pausedUsingAgent && agentIdToUse) {
          await agentHub.call<any>(agentIdToUse, 'resumeAddForScrape', { accountId }, { timeoutMs: 15000 }).catch(() => {});
        } else {
          resumeAdd(accountId);
        }
      }

      try {
        const cartSkuLoaded = cart?.success && Array.isArray(cart?.products) ? cart.products.length : 0;
        const cartSkuTotalRaw = (cart as any)?.uiTotalCount;
        const cartSkuTotal =
          typeof cartSkuTotalRaw === 'number' && Number.isFinite(cartSkuTotalRaw) ? cartSkuTotalRaw : null;
        setCartSkuStats(accountId, { cartSkuTotal, cartSkuLoaded });
      } catch {}

      // 限量模式：抓价时若该商品 SKU 数不足，则先补齐再更新价格（只对带 skuTarget 元数据的新增任务生效）
      if (cart?.success && Array.isArray(cart?.products)) {
        try {
          const uiTotalCountRaw = (cart as any)?.uiTotalCount;
          const uiTotalCount =
            typeof uiTotalCountRaw === 'number' && Number.isFinite(uiTotalCountRaw) ? uiTotalCountRaw : null;
          const cartLoadedQty = cart.products.length;
          const canTrustSkuCounts = uiTotalCount === null || cartLoadedQty >= uiTotalCount;

          if (!canTrustSkuCounts) {
            await job.log(`购物车未完全加载 loaded=${cartLoadedQty} < uiTotal=${uiTotalCount}，跳过SKU补齐`);
            console.log(
              `[Scheduler] 购物车未完全加载，跳过SKU补齐 accountId=${accountId} loaded=${cartLoadedQty} uiTotal=${uiTotalCount}`
            );
          } else {
          const baseProducts = await prisma.product.findMany({
            where: {
              ownerAccountId: accountId,
              monitorMode: 'CART',
              skuId: CART_BASE_SKU_ID,
              isActive: true,
            },
            select: { id: true, taobaoId: true },
          });

          const productIds = baseProducts.map((p) => p.id);
          const snapshots = productIds.length
            ? await prisma.priceSnapshot.findMany({
                where: { productId: { in: productIds } },
                orderBy: [{ productId: 'asc' }, { capturedAt: 'desc' }],
                distinct: ['productId'],
                select: { productId: true, rawData: true },
              })
            : [];

          const latestRawByProductId = new Map<string, any>();
          for (const s of snapshots as any[]) {
            const pid = String(s?.productId || '').trim();
            if (!pid || latestRawByProductId.has(pid)) continue;
            latestRawByProductId.set(pid, (s as any)?.rawData ?? null);
          }

          const skuKeysByTaobaoId = new Map<string, Set<string>>();
          for (const p of cart.products as any[]) {
            const tid = p?.taobaoId ? String(p.taobaoId).trim() : '';
            if (!tid) continue;
            const skuId = p?.skuId ? String(p.skuId).trim() : '';
            const skuProps = normalizeSkuProperties(String(p?.skuProperties || '').trim());
            const key = skuId || skuProps;
            if (!key) continue;
            const set = skuKeysByTaobaoId.get(tid) ?? new Set<string>();
            set.add(key);
            skuKeysByTaobaoId.set(tid, set);
          }

          const underfilled: Array<{ taobaoId: string; current: number; target: number }> = [];
          for (const bp of baseProducts as any[]) {
            const tid = String(bp?.taobaoId || '').trim();
            if (!tid) continue;
            const raw = latestRawByProductId.get(String(bp.id)) ?? null;
            const cartAddSkuLimitRaw = raw?.cartAddSkuLimit;
            const skuTargetRaw = raw?.skuTarget;

            const cartAddSkuLimitNum =
              typeof cartAddSkuLimitRaw === 'number' ? cartAddSkuLimitRaw : Number(cartAddSkuLimitRaw);
            const skuTargetNum = typeof skuTargetRaw === 'number' ? skuTargetRaw : Number(skuTargetRaw);

            const cartAddSkuLimit =
              Number.isFinite(cartAddSkuLimitNum) && cartAddSkuLimitNum >= 0 ? Math.floor(cartAddSkuLimitNum) : null;
            const skuTarget =
              Number.isFinite(skuTargetNum) && skuTargetNum > 0 ? Math.floor(skuTargetNum) : null;

            if (!skuTarget) continue;
            if (cartAddSkuLimit !== null && cartAddSkuLimit <= 0) continue;

            const current = skuKeysByTaobaoId.get(tid)?.size ?? 0;
            if (current > 0 && current < skuTarget) underfilled.push({ taobaoId: tid, current, target: skuTarget });
          }

          if (underfilled.length > 0) {
            await job.log(`检测到 ${underfilled.length} 个商品SKU不足，开始补齐...`);
            console.log(
              `[Scheduler] SKU不足，触发补齐 accountId=${accountId} items=${underfilled
                .map((x) => `${x.taobaoId}:${x.current}/${x.target}`)
                .join(',')}`
            );

            for (const item of underfilled) {
              await job.log(`补齐 taobaoId=${item.taobaoId} current=${item.current} target=${item.target}`);
                  const addResult = agentIdToUse && agentHub.isConnected(agentIdToUse)
                ? await agentHub.call<any>(
                    agentIdToUse,
                    'addAllSkusToCart',
                    {
                      accountId,
                      taobaoId: item.taobaoId,
                      cookies: account.cookies,
                      delayScale: humanDelayScale,
                      skuDelayMinMs: cartAddSkuDelayMinMs,
                      skuDelayMaxMs: cartAddSkuDelayMaxMs,
                      cartAddSkuLimit: item.target,
                      // Backward-compatible aliases for older agents
                      skuLimit: item.target,
                      skuDelayMs: { min: cartAddSkuDelayMinMs, max: cartAddSkuDelayMaxMs },
                    },
                    { timeoutMs: 30 * 60 * 1000 }
                  )
                : await autoCartAdder.addAllSkusToCart(accountId, item.taobaoId, account.cookies, {
                    headless: true,
                    skuLimit: item.target,
                    skuDelayMs: { min: cartAddSkuDelayMinMs, max: cartAddSkuDelayMaxMs },
                  });

              const done = `${(addResult as any)?.successCount ?? 0}/${(addResult as any)?.totalSkus ?? 0}`;
              await job.log(`补齐完成 taobaoId=${item.taobaoId} success=${done}`);
            }

            // 补齐后重新抓取一次购物车（使用同样的抢占机制避免与加购冲突）
            const pauseTimeoutMs = 20000;
            const pausedUsingAgent = Boolean(agentIdToUse && agentHub.isConnected(agentIdToUse));
            if (pausedUsingAgent && agentIdToUse) {
              await agentHub
                .call<any>(agentIdToUse, 'pauseAddForScrape', { accountId, timeoutMs: pauseTimeoutMs }, { timeoutMs: pauseTimeoutMs + 5000 })
                .catch(() => {});
            } else {
              await requestPauseForAddWithTimeout(accountId, pauseTimeoutMs).catch(() => {});
            }

            try {
              const next = await scrapeCart();
              if (next?.success) cart = next;
            } finally {
              if (pausedUsingAgent && agentIdToUse) {
                await agentHub.call<any>(agentIdToUse, 'resumeAddForScrape', { accountId }, { timeoutMs: 15000 }).catch(() => {});
              } else {
                resumeAdd(accountId);
              }
            }

            try {
              const cartSkuLoaded = cart?.success && Array.isArray(cart?.products) ? cart.products.length : 0;
              const cartSkuTotalRaw = (cart as any)?.uiTotalCount;
              const cartSkuTotal =
                typeof cartSkuTotalRaw === 'number' && Number.isFinite(cartSkuTotalRaw) ? cartSkuTotalRaw : null;
              setCartSkuStats(accountId, { cartSkuTotal, cartSkuLoaded });
            } catch {}
          }
          }
        } catch (e) {
          console.warn(`[Scheduler] SKU补齐逻辑异常，忽略并继续抓价 accountId=${accountId}:`, e);
        }
      }

      const result = await cartScraper.updatePricesFromCart(accountId, account.cookies, { cartResult: cart });

      console.log(
        `[Scheduler] 购物车抓价完成 accountId=${accountId} updated=${result.updated} missing=${result.missing} failed=${result.failed}`
      );

      return {
        success: true,
        updated: result.updated,
        failed: result.failed,
        missing: result.missing
      };
    } catch (error) {
      console.error(`[Scheduler] 购物车抓价失败 accountId=${accountId}:`, error);
      throw error;
    }
  }

  private async processCartRemoveJob(job: Job): Promise<{ success: boolean; taobaoId: string; removed: number }> {
    const jobIdText = toJobIdText(job.id);
    const accountId = String((job.data as any)?.accountId || '').trim();
    const taobaoId = String((job.data as any)?.taobaoId || '').trim();

    if (!accountId || !isDigits(taobaoId)) {
      throw new Error('Invalid cart-remove job payload');
    }

    const account = await prisma.taobaoAccount.findUnique({
      where: { id: accountId },
      select: { id: true, cookies: true, agentId: true, userId: true }
    });

    if (!account) {
      throw new Error('Account not found');
    }

    const agentIdToUse = await this.resolveAgentIdForAccount(account, null);
    const connectedAgentId = agentIdToUse && agentHub.isConnected(agentIdToUse) ? agentIdToUse : null;
    if (account.agentId && (!agentIdToUse || !agentHub.isConnected(agentIdToUse))) {
      console.warn(
        `[Scheduler] 账号绑定Agent离线，回退到本地删购物车 jobId=${jobIdText} accountId=${accountId} boundAgentId=${String(account.agentId)}`
      );
    }

    console.log(
      `[Scheduler] 购物车删除执行器 jobId=${jobIdText} accountId=${accountId} boundAgentId=${account.agentId || 'null'} agentId=${
        connectedAgentId || 'local'
      } taobaoId=${taobaoId}`
    );

    const pauseTimeoutMs = 20000;
    const pausedUsingAgent = Boolean(connectedAgentId);
    if (pausedUsingAgent && agentIdToUse) {
      await agentHub
        .call<any>(agentIdToUse, 'pauseAddForScrape', { accountId, timeoutMs: pauseTimeoutMs }, { timeoutMs: pauseTimeoutMs + 5000 })
        .catch((err) => {
          console.warn(`[Scheduler] 删购物车前暂停加购失败 accountId=${accountId} agentId=${agentIdToUse}:`, err);
        });
    } else {
      await requestPauseForAddWithTimeout(accountId, pauseTimeoutMs).catch(() => {});
    }

    try {
      const removeViaAgent = async (): Promise<any> => {
        if (!agentIdToUse) throw new Error('Missing agentId');
        return agentHub.call<any>(
          agentIdToUse,
          'removeTaobaoIdFromCart',
          { accountId, taobaoId, cookies: account.cookies },
          { timeoutMs: 10 * 60 * 1000 }
        );
      };

      const removeViaLocal = async (): Promise<any> => {
        return cartScraper.removeTaobaoIdFromCart(accountId, taobaoId, account.cookies);
      };

      let removeResult: any;
      if (pausedUsingAgent && agentIdToUse) {
        try {
          removeResult = await removeViaAgent();
        } catch (err: any) {
          const msg = err?.message ? String(err.message) : String(err);
          if (/Unknown method/i.test(msg)) {
            console.warn(`[Scheduler] Agent 不支持 removeTaobaoIdFromCart，回退本地执行 accountId=${accountId} agentId=${agentIdToUse}`);
            removeResult = await removeViaLocal();
          } else {
            throw err;
          }
        }
      } else {
        removeResult = await removeViaLocal();
      }

      const removedRaw = (removeResult as any)?.removed;
      const removed = typeof removedRaw === 'number' && Number.isFinite(removedRaw) ? Math.max(0, Math.floor(removedRaw)) : 0;

      try {
        await job.log(`removed=${removed} taobaoId=${taobaoId}`);
      } catch {}

      console.log(
        `[Scheduler] 购物车删除完成 jobId=${jobIdText} accountId=${accountId} agentId=${connectedAgentId || 'local'} taobaoId=${taobaoId} removed=${removed}`
      );

      // 刷新一次购物车统计，避免“已满”状态卡住
      const scrapeCart = async (): Promise<any> => {
        if (agentIdToUse && agentHub.isConnected(agentIdToUse)) {
          return agentHub.call<any>(agentIdToUse, 'scrapeCart', { accountId, cookies: account.cookies }, { timeoutMs: 10 * 60 * 1000 });
        }
        return cartScraper.scrapeCart(accountId, account.cookies);
      };

      const cart = await scrapeCart().catch(() => null as any);
      try {
        const cartSkuLoaded = cart?.success && Array.isArray(cart?.products) ? cart.products.length : 0;
        const cartSkuTotalRaw = (cart as any)?.uiTotalCount;
        const cartSkuTotal = typeof cartSkuTotalRaw === 'number' && Number.isFinite(cartSkuTotalRaw) ? cartSkuTotalRaw : null;
        setCartSkuStats(accountId, { cartSkuTotal, cartSkuLoaded });
      } catch {}

      return { success: true, taobaoId, removed };
    } finally {
      if (pausedUsingAgent && agentIdToUse) {
        await agentHub.call<any>(agentIdToUse, 'resumeAddForScrape', { accountId }, { timeoutMs: 15000 }).catch(() => {});
      } else {
        resumeAdd(accountId);
      }
    }
  }

  private async processCartAddJob(job: Job): Promise<{ success: boolean; taobaoId: string; productId: string }> {
    const jobIdText = toJobIdText(job.id);
    const ownerUserIdRaw = (job.data as any)?.ownerUserId;
    const ownerUserId = typeof ownerUserIdRaw === 'string' ? ownerUserIdRaw.trim() : null;
    const useAccountPool = Boolean((job.data as any)?.useAccountPool);
    const requestedAccountIdRaw = (job.data as any)?.accountId;
    const requestedAccountId = typeof requestedAccountIdRaw === 'string' ? requestedAccountIdRaw.trim() : '';
    const taobaoId = String((job.data as any)?.taobaoId || '').trim();
    const url = String((job.data as any)?.url || '').trim();

    if (!taobaoId || !url || (!useAccountPool && !requestedAccountId)) {
      throw new Error('Invalid cart-add job payload');
    }

    let accountId = requestedAccountId;
    if (useAccountPool) {
      const poolAccounts = await prisma.taobaoAccount.findMany({
        where: { isActive: true, ...(ownerUserId ? { userId: ownerUserId } : {}) },
        select: { id: true, agentId: true, userId: true },
        orderBy: { createdAt: 'asc' },
      });

      const poolAccountIds = poolAccounts.map((a) => a.id);
      const preferredAccountId = requestedAccountId || null;

      // 优先选择“可用 Agent 在线”的账号，避免回退到本地浏览器（Docker 环境会直接失败）
      const onlineAccountIds: string[] = [];
      for (const acc of poolAccounts) {
        const agentId = await this.resolveAgentIdForAccount(acc, ownerUserId);
        if (agentId && agentHub.isConnected(agentId)) {
          onlineAccountIds.push(acc.id);
        }
      }

      const candidateAccountIds = onlineAccountIds.length > 0 ? onlineAccountIds : poolAccountIds;
      accountId = this.pickAccountIdFromPool(candidateAccountIds, preferredAccountId);
    }

    const scraperConfig = await (prisma as any)
      .scraperConfig.findFirst({ orderBy: { updatedAt: 'desc' } })
      .catch(() => null as any);
    const humanDelayScale =
      typeof scraperConfig?.humanDelayScale === 'number' && Number.isFinite(scraperConfig.humanDelayScale)
        ? scraperConfig.humanDelayScale
        : 1;
    setHumanDelayScale(humanDelayScale);
    const cartAddSkuDelayMinMsRaw = Number((scraperConfig as any)?.cartAddSkuDelayMinMs);
    const cartAddSkuDelayMaxMsRaw = Number((scraperConfig as any)?.cartAddSkuDelayMaxMs);
    const cartAddSkuDelayMinMs = Number.isFinite(cartAddSkuDelayMinMsRaw) ? Math.max(0, Math.floor(cartAddSkuDelayMinMsRaw)) : 900;
    const cartAddSkuDelayMaxMs = Number.isFinite(cartAddSkuDelayMaxMsRaw)
      ? Math.max(cartAddSkuDelayMinMs, Math.floor(cartAddSkuDelayMaxMsRaw))
      : 2200;

    const cartAddSkuLimitDefaultRaw = Number((scraperConfig as any)?.cartAddSkuLimit);
    const cartAddSkuLimitDefault = Number.isFinite(cartAddSkuLimitDefaultRaw)
      ? Math.max(0, Math.floor(cartAddSkuLimitDefaultRaw))
      : 0;
    const cartAddSkuLimitOverrideRaw = Object.prototype.hasOwnProperty.call(job.data as any, 'cartAddSkuLimit')
      ? (job.data as any).cartAddSkuLimit
      : undefined;
    const cartAddSkuLimitOverrideNum =
      cartAddSkuLimitOverrideRaw === undefined
        ? null
        : typeof cartAddSkuLimitOverrideRaw === 'number'
          ? cartAddSkuLimitOverrideRaw
          : Number(cartAddSkuLimitOverrideRaw);
    const cartAddSkuLimit =
      cartAddSkuLimitOverrideNum !== null && Number.isFinite(cartAddSkuLimitOverrideNum)
        ? Math.max(0, Math.floor(cartAddSkuLimitOverrideNum))
        : cartAddSkuLimitDefault;

    await job.updateProgress({ total: 0, current: 0, success: 0, failed: 0 });
    await job.log(`开始处理商品 ${taobaoId}...`);
    await job.log(`delayScale=${humanDelayScale}`);
    await job.log(`skuLimit=${cartAddSkuLimit > 0 ? cartAddSkuLimit : 'all'}`);

    const account = await prisma.taobaoAccount.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, cookies: true, agentId: true, userId: true, isActive: true },
    });

    if (!account || !account.isActive) {
      throw new Error('Account not found or inactive');
    }

    const agentIdToUse = await this.resolveAgentIdForAccount(account, ownerUserId);
    await job.log(
      `使用账号 accountId=${accountId} agentId=${agentIdToUse && agentHub.isConnected(agentIdToUse) ? agentIdToUse : 'local'}`
    );
    if (account.agentId && (!agentIdToUse || !agentHub.isConnected(agentIdToUse))) {
      console.warn(
        `[Scheduler] 账号绑定Agent离线，回退到本地加购 jobId=${jobIdText} accountId=${accountId} boundAgentId=${String(account.agentId)}`
      );
    }

    const alreadyMonitoredBase =
      (await prisma.product
        .findFirst({
          where: {
            monitorMode: 'CART',
            taobaoId,
            skuId: CART_BASE_SKU_ID,
            ...(ownerUserId ? { ownerAccount: { is: { userId: ownerUserId } } } : {}),
          },
          select: { id: true },
        })
        .catch(() => null as any)) ?? null;

    const alreadyMonitored =
      alreadyMonitoredBase ||
      ((await prisma.product
        .findFirst({
          where: {
            monitorMode: 'CART',
            taobaoId,
            ...(ownerUserId ? { ownerAccount: { is: { userId: ownerUserId } } } : {}),
          },
          select: { id: true },
        })
        .catch(() => null as any)) ?? null);
    if (alreadyMonitored?.id) {
      await job.updateProgress({ total: 0, current: 0, success: 0, failed: 0 });
      await job.log('该商品已在监控，已忽略（不重复加购）');
      console.log(`[Scheduler] 加购任务已忽略（已在监控）jobId=${jobIdText} taobaoId=${taobaoId}`);
      return { success: true, taobaoId, productId: String(alreadyMonitored.id) };
    }

    const queueStats = await getCartAddQueueStats().catch(() => null as any);
    console.log(
      `[Scheduler] 加购任务开始 jobId=${jobIdText} accountId=${accountId} agentId=${
        agentIdToUse && agentHub.isConnected(agentIdToUse) ? agentIdToUse : 'local'
      } taobaoId=${taobaoId}${
        queueStats ? ` ${formatCartAddQueueStats(queueStats)}` : ''
      }`
    );

    let lastProgressUpdateAt = 0;
    let lastConsoleAt = 0;
    let lastConsoleTotal = -1;
    const logAddProgressToConsole = (progress: any) => {
      const totalRaw = typeof progress?.total === 'number' ? progress.total : Number(progress?.total);
      const currentRaw = typeof progress?.current === 'number' ? progress.current : Number(progress?.current);
      const successRaw = typeof progress?.success === 'number' ? progress.success : Number(progress?.success);
      const failedRaw = typeof progress?.failed === 'number' ? progress.failed : Number(progress?.failed);

      const total = Number.isFinite(totalRaw) ? Math.max(0, Math.floor(totalRaw)) : 0;
      const current = Number.isFinite(currentRaw) ? Math.max(0, Math.floor(currentRaw)) : 0;
      const success = Number.isFinite(successRaw) ? Math.max(0, Math.floor(successRaw)) : 0;
      const failed = Number.isFinite(failedRaw) ? Math.max(0, Math.floor(failedRaw)) : 0;
      if (total <= 0) return;

      const now = Date.now();
      const shouldLog = total !== lastConsoleTotal || now - lastConsoleAt >= 2000 || current >= total;
      if (!shouldLog) return;
      lastConsoleAt = now;
      lastConsoleTotal = total;
      console.log(
        `[Scheduler] 加购任务进度 jobId=${jobIdText} taobaoId=${taobaoId} SKU=${current}/${total} 成功=${success} 失败=${failed}`
      );
    };

    const onProgress = (progress: any, log?: string) => {
      const now = Date.now();
      const shouldUpdate =
        now - lastProgressUpdateAt > 250 ||
        (progress &&
          typeof progress.total === 'number' &&
          typeof progress.current === 'number' &&
          progress.total > 0 &&
          progress.current >= progress.total);
      if (shouldUpdate) {
        lastProgressUpdateAt = now;
        void job.updateProgress(progress).catch(() => {});
      }
      if (log) void job.log(log).catch(() => {});
      logAddProgressToConsole(progress);
    };

    const result = agentIdToUse
      ? await agentHub.call<any>(
          agentIdToUse,
          'addAllSkusToCart',
          {
            accountId,
            taobaoId,
            cookies: account.cookies,
            delayScale: humanDelayScale,
            skuDelayMinMs: cartAddSkuDelayMinMs,
            skuDelayMaxMs: cartAddSkuDelayMaxMs,
            cartAddSkuLimit,
            // Backward-compatible aliases for older agents
            skuLimit: cartAddSkuLimit,
            skuDelayMs: { min: cartAddSkuDelayMinMs, max: cartAddSkuDelayMaxMs },
          },
          { timeoutMs: 30 * 60 * 1000, onProgress }
        )
      : await autoCartAdder.addAllSkusToCart(accountId, taobaoId, account.cookies, {
          headless: false,
          onProgress,
          skuLimit: cartAddSkuLimit,
          skuDelayMs: { min: cartAddSkuDelayMinMs, max: cartAddSkuDelayMaxMs },
        });

    const finalProgress = {
      total: result.totalSkus,
      current: result.totalSkus,
      success: result.successCount,
      failed: result.failedCount,
    };
    await job.updateProgress(finalProgress);
    await job.log(`SKU处理完成: ${result.successCount}/${result.totalSkus}`);
    console.log(
      `[Scheduler] 加购任务SKU完成 jobId=${jobIdText} taobaoId=${taobaoId} 成功=${result.successCount}/${result.totalSkus} 失败=${result.failedCount}`
    );

    try {
      const uiTotalCountRaw = (result as any)?.uiTotalCount;
      const uiTotalCount =
        typeof uiTotalCountRaw === 'number' && Number.isFinite(uiTotalCountRaw) ? uiTotalCountRaw : null;
      if (uiTotalCount !== null) {
        const prev = getCartSkuStats(accountId);
        const loaded = prev?.cartSkuLoaded ?? 0;
        setCartSkuStats(accountId, { cartSkuTotal: uiTotalCount, cartSkuLoaded: Math.min(loaded, uiTotalCount) });
      }
    } catch {}

    const existingBase = await prisma.product.findFirst({
      where: {
        taobaoId,
        skuId: CART_BASE_SKU_ID,
        ownerAccountId: accountId,
      },
      select: { id: true },
    });

    const baseProduct = existingBase
      ? await prisma.product.update({
          where: { id: existingBase.id },
          data: {
            monitorMode: 'CART',
            ownerAccountId: accountId,
            url,
            isActive: true,
            lastError: null,
          },
        })
      : await prisma.product.create({
          data: {
            taobaoId,
            skuId: CART_BASE_SKU_ID,
            monitorMode: 'CART',
            ownerAccountId: accountId,
            url,
            isActive: true,
          },
        });

    await job.log('正在处理购物车数据...');

    const successResults = (result.results || []).filter((r: any) => r && r.success);
    const wantedNumericSkuIds = new Set(
      successResults.map((r: any) => String(r.skuId || '').trim()).filter((id: string) => isDigits(id))
    );

    const metaBySkuId = new Map<string, any>();
    const metaByProps = new Map<string, any>();
    for (const r of successResults) {
      metaBySkuId.set(String(r.skuId || '').trim(), r);
      metaByProps.set(normalizeSkuProperties(r.skuProperties), r);
    }

    let matched: any[] = result.cartProducts || [];
    if (matched.length === 0) {
      await job.log('cartProducts 为空，尝试 scrapeCart...');
      let lastCartError: string | null = null;
      for (let i = 0; i < 3; i++) {
        const cart = agentIdToUse
          ? await agentHub.call<any>(
              agentIdToUse,
              'scrapeCart',
              { accountId, cookies: account.cookies, delayScale: humanDelayScale, expectedTaobaoIds: [taobaoId] },
              { timeoutMs: 10 * 60 * 1000 }
            )
          : await cartScraper.scrapeCart(accountId, account.cookies, { expectedTaobaoIds: [taobaoId] });

        if (!cart.success) {
          lastCartError = cart.error || 'scrapeCart failed';
        } else {
          let items = cart.products.filter((p: any) => String(p.taobaoId) === String(taobaoId));
          if (wantedNumericSkuIds.size > 0) {
            items = items.filter((p: any) => wantedNumericSkuIds.has(String(p.skuId)));
          }
          matched = items;
          if (matched.length > 0) break;
        }
        await sleep(1500);
      }

      if (matched.length === 0) {
        const msg = `首次加购完成，但未抓到购物车价格/图片：${lastCartError ?? 'unknown'}`;
        await job.log(msg);
        await prisma.product.update({
          where: { id: baseProduct.id },
          data: { lastCheckAt: new Date(), lastError: msg },
        });
      }
    }

    if (matched.length > 0) {
      const variants = matched.map((c: any) => {
        const skuId = String(c.skuId || '').trim();
        const props = normalizeSkuProperties(c.skuProperties);
        const meta = metaBySkuId.get(skuId) || metaByProps.get(props) || null;
        const selections = Array.isArray(meta?.selections) ? meta.selections : [];
        const vidPath = selections
          .map((s: any) => s?.vid)
          .filter(Boolean)
          .map((x: any) => String(x))
          .join(';');

        return {
          skuId: skuId || null,
          skuProperties: meta?.skuProperties ?? c.skuProperties ?? null,
          vidPath,
          selections,
          finalPrice: typeof c.finalPrice === 'number' ? c.finalPrice : null,
          originalPrice: typeof c.originalPrice === 'number' ? c.originalPrice : null,
          thumbnailUrl: c.imageUrl || meta?.thumbnailUrl || null,
        };
      });

      const prices = variants.map((v: any) => v.finalPrice).filter((n: any) => typeof n === 'number' && n > 0);
      const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
      const origs = variants.map((v: any) => v.originalPrice).filter((n: any) => typeof n === 'number' && n > 0);
      const minOrig = origs.length > 0 ? Math.min(...origs) : null;
      const first = matched[0];

      await prisma.product.update({
        where: { id: baseProduct.id },
        data: {
          title: first?.title || undefined,
          imageUrl: first?.imageUrl || undefined,
          currentPrice: minPrice,
          originalPrice: minOrig ?? undefined,
          lastCheckAt: new Date(),
          lastError: null,
        },
      });

      const rawData: any = { taobaoId, source: 'cart_initial', variants, cartAddSkuLimit };
      try {
        const skuTotalRaw = (result as any)?.skuTotal;
        const skuAvailableRaw = (result as any)?.skuAvailable;
        const skuTargetRaw = (result as any)?.skuTarget;

        const skuTotalNum = typeof skuTotalRaw === 'number' ? skuTotalRaw : Number(skuTotalRaw);
        const skuAvailableNum = typeof skuAvailableRaw === 'number' ? skuAvailableRaw : Number(skuAvailableRaw);
        const skuTargetNum = typeof skuTargetRaw === 'number' ? skuTargetRaw : Number(skuTargetRaw);

        if (Number.isFinite(skuTotalNum) && skuTotalNum >= 0) rawData.skuTotal = Math.floor(skuTotalNum);
        if (Number.isFinite(skuAvailableNum) && skuAvailableNum >= 0) rawData.skuAvailable = Math.floor(skuAvailableNum);
        if (Number.isFinite(skuTargetNum) && skuTargetNum >= 0) rawData.skuTarget = Math.floor(skuTargetNum);
      } catch {}

      await prisma.priceSnapshot.create({
        data: {
          productId: baseProduct.id,
          finalPrice: minPrice,
          originalPrice: minOrig,
          accountId,
          rawData,
        },
      });

      await job.log(`已写入SKU快照: ${variants.length} 个SKU`);

      await prisma.product
        .updateMany({
          where: {
            ownerAccountId: accountId,
            monitorMode: 'CART',
            taobaoId,
            NOT: { skuId: CART_BASE_SKU_ID },
          },
          data: { isActive: false },
        })
        .catch(() => {});
    }

    return { success: true, taobaoId, productId: baseProduct.id };
  }

  private async processCartBatchAddJobAccountPool(
    job: Job,
    params: {
      batchJobIdText: string;
      items: any[];
      ownerUserId: string | null;
      preferredAccountId: string | null;
      humanDelayScale: number;
      cartAddSkuLimit: number;
      cartAddSkuDelayMinMs: number;
      cartAddSkuDelayMaxMs: number;
      cartAddProductDelayMinMs: number;
      cartAddProductDelayMaxMs: number;
    }
  ): Promise<any> {
    const {
      batchJobIdText,
      items,
      ownerUserId,
      preferredAccountId,
      humanDelayScale,
      cartAddSkuLimit,
      cartAddSkuDelayMinMs,
      cartAddSkuDelayMaxMs,
      cartAddProductDelayMinMs,
      cartAddProductDelayMaxMs,
    } = params;

    const poolAccounts = await prisma.taobaoAccount.findMany({
      where: { isActive: true, ...(ownerUserId ? { userId: ownerUserId } : {}) },
      select: { id: true, name: true, cookies: true, agentId: true, userId: true, isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    if (poolAccounts.length === 0) {
      throw new Error('No active account available');
    }

    const poolAccountIds = poolAccounts.map((a) => a.id);
    const poolById = new Map(poolAccounts.map((a) => [a.id, a]));
    const agentIdCache = new Map<string, string | null>();

    const getAgentIdToUse = async (accountId: string): Promise<string | null> => {
      const cached = agentIdCache.get(accountId);
      if (cached !== undefined) return cached;

      const account = poolById.get(accountId) ?? null;
      const resolved = account ? await this.resolveAgentIdForAccount(account, ownerUserId) : null;
      agentIdCache.set(accountId, resolved);
      return resolved;
    };

    const onlinePoolAccountIds: string[] = [];
    for (const id of poolAccountIds) {
      const agentId = await getAgentIdToUse(id);
      if (agentId && agentHub.isConnected(agentId)) {
        onlinePoolAccountIds.push(id);
      }
    }

    const selectablePoolAccountIds = onlinePoolAccountIds.length > 0 ? onlinePoolAccountIds : poolAccountIds;

    const status: any = {
      status: 'running',
      progress: {
        totalItems: items.length,
        currentIndex: 0,
        completedItems: 0,
        successItems: 0,
        failedItems: 0,
      },
      items: items.map((it) => ({
        index: it.index,
        url: it.url,
        taobaoId: it.taobaoId,
        status: 'pending',
      })),
      ownerUserId,
    };

    await job.updateProgress(status);
    await job.log(`开始批量加购（账号池）${items.length} 个商品 delayScale=${humanDelayScale}`);
    const batchQueueStats = await getCartAddQueueStats().catch(() => null as any);
    console.log(
      `[Scheduler] 批量加购（账号池）开始 batchJobId=${batchJobIdText} items=${items.length} accounts=${poolAccountIds.length}${
        batchQueueStats ? ` ${formatCartAddQueueStats(batchQueueStats)}` : ''
      }`
    );

    const batchTaobaoIds = items.map((it) => String(it?.taobaoId || '').trim()).filter(Boolean);
    const monitoredRows = await prisma.product
      .findMany({
        where: {
          monitorMode: 'CART',
          taobaoId: { in: batchTaobaoIds },
          ...(ownerUserId ? { ownerAccount: { is: { userId: ownerUserId } } } : {}),
        },
        select: { id: true, taobaoId: true, skuId: true },
      })
      .catch(() => [] as any[]);

    const alreadyMonitoredByTaobaoId = new Map<string, string>();
    for (const row of monitoredRows as any[]) {
      const id = String(row?.id || '').trim();
      const tid = String(row?.taobaoId || '').trim();
      const skuId = String(row?.skuId || '').trim();
      if (!id || !tid) continue;
      if (!alreadyMonitoredByTaobaoId.has(tid) || skuId === CART_BASE_SKU_ID) {
        alreadyMonitoredByTaobaoId.set(tid, id);
      }
    }

    let performedAdd = 0;
    let lastBatchUpdateAt = 0;

    const flushBatchProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastBatchUpdateAt < 250) return;
      lastBatchUpdateAt = now;
      void job.updateProgress(status).catch(() => {});
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemStatus = status.items[i];
      const itemTaobaoId = String(item?.taobaoId || '').trim();
      status.progress.currentIndex = i;

      const existingProductId = itemTaobaoId ? alreadyMonitoredByTaobaoId.get(itemTaobaoId) ?? null : null;
      if (existingProductId) {
        itemStatus.status = 'completed';
        itemStatus.productId = existingProductId;
        itemStatus.progress = { total: 0, current: 0, success: 0, failed: 0 };
        status.progress.completedItems++;
        status.progress.successItems++;
        await job.log(`[${item.index}] 已在监控，已忽略`);
        flushBatchProgress(true);
        continue;
      }

      if (performedAdd > 0 && cartAddProductDelayMaxMs > 0) {
        const scaledMin = Math.max(0, Math.floor(cartAddProductDelayMinMs * humanDelayScale));
        const scaledMax = Math.max(scaledMin, Math.floor(cartAddProductDelayMaxMs * humanDelayScale));
        const delay = randomDelay(scaledMin, scaledMax);
        if (delay > 0) {
          await job.log(`[${item.index}] 加购间隔等待 ${delay}ms`);
          await sleep(delay);
        }
      }

      const itemAccountId = this.pickAccountIdFromPool(selectablePoolAccountIds, preferredAccountId);
      const account = poolById.get(itemAccountId) ?? null;
      if (!account || !account.isActive) {
        throw new Error(`Account not found or inactive: ${itemAccountId}`);
      }

      itemStatus.accountId = itemAccountId;
      itemStatus.accountName = account.name || undefined;

      const agentIdToUse = await getAgentIdToUse(itemAccountId);
      itemStatus.agentId = agentIdToUse;

      itemStatus.status = 'running';
      await job.log(
        `[${item.index}] 开始处理 accountId=${itemAccountId} agentId=${
          agentIdToUse && agentHub.isConnected(agentIdToUse) ? agentIdToUse : 'local'
        } taobaoId=${itemTaobaoId}`
      );
      flushBatchProgress(true);

      try {
        setHumanDelayScale(humanDelayScale);
        const itemIndex1 = i + 1;

        let lastConsoleAt = 0;
        let lastConsoleTotal = -1;
        const logBatchSkuProgressToConsole = (progress: any) => {
          const totalRaw = typeof progress?.total === 'number' ? progress.total : Number(progress?.total);
          const currentRaw = typeof progress?.current === 'number' ? progress.current : Number(progress?.current);
          const successRaw = typeof progress?.success === 'number' ? progress.success : Number(progress?.success);
          const failedRaw = typeof progress?.failed === 'number' ? progress.failed : Number(progress?.failed);

          const total = Number.isFinite(totalRaw) ? Math.max(0, Math.floor(totalRaw)) : 0;
          const current = Number.isFinite(currentRaw) ? Math.max(0, Math.floor(currentRaw)) : 0;
          const success = Number.isFinite(successRaw) ? Math.max(0, Math.floor(successRaw)) : 0;
          const failed = Number.isFinite(failedRaw) ? Math.max(0, Math.floor(failedRaw)) : 0;
          if (total <= 0) return;

          const now = Date.now();
          const shouldLog = total !== lastConsoleTotal || now - lastConsoleAt >= 2000 || current >= total;
          if (!shouldLog) return;
          lastConsoleAt = now;
          lastConsoleTotal = total;
          console.log(
            `[Scheduler] 批量加购进度(batchJobId=${batchJobIdText}) 总体=${status.progress.completedItems}/${status.progress.totalItems} 当前=${itemIndex1}/${items.length} accountId=${itemAccountId} taobaoId=${itemTaobaoId} SKU=${current}/${total} 成功=${success} 失败=${failed}`
          );
        };

        const onProgress = (progress: any, log?: string) => {
          itemStatus.progress = progress;
          flushBatchProgress();
          if (log) void job.log(`[${item.index}] ${log}`).catch(() => {});
          logBatchSkuProgressToConsole(progress);
        };

        const result = agentIdToUse
          ? await agentHub.call<any>(
              agentIdToUse,
              'addAllSkusToCart',
              {
                accountId: itemAccountId,
                taobaoId: item.taobaoId,
                cookies: account.cookies,
                delayScale: humanDelayScale,
                skuDelayMinMs: cartAddSkuDelayMinMs,
                skuDelayMaxMs: cartAddSkuDelayMaxMs,
                cartAddSkuLimit,
                // Backward-compatible aliases for older agents
                skuLimit: cartAddSkuLimit,
                skuDelayMs: { min: cartAddSkuDelayMinMs, max: cartAddSkuDelayMaxMs },
              },
              { timeoutMs: 30 * 60 * 1000, onProgress }
            )
          : await autoCartAdder.addAllSkusToCart(itemAccountId, item.taobaoId, account.cookies, {
              headless: false,
              onProgress,
              skuLimit: cartAddSkuLimit,
              skuDelayMs: { min: cartAddSkuDelayMinMs, max: cartAddSkuDelayMaxMs },
            });

        performedAdd++;

        try {
          const uiTotalCountRaw = (result as any)?.uiTotalCount;
          const uiTotalCount =
            typeof uiTotalCountRaw === 'number' && Number.isFinite(uiTotalCountRaw) ? uiTotalCountRaw : null;
          if (uiTotalCount !== null) {
            const prev = getCartSkuStats(itemAccountId);
            const loaded = prev?.cartSkuLoaded ?? 0;
            setCartSkuStats(itemAccountId, { cartSkuTotal: uiTotalCount, cartSkuLoaded: Math.min(loaded, uiTotalCount) });
          }
        } catch {}

        itemStatus.progress = {
          total: result.totalSkus,
          current: result.totalSkus,
          success: result.successCount,
          failed: result.failedCount,
        };
        flushBatchProgress(true);

        await job.log(`[${item.index}] SKU处理完成: ${result.successCount}/${result.totalSkus}`);

        const existingBase = await prisma.product.findFirst({
          where: {
            taobaoId: item.taobaoId,
            skuId: CART_BASE_SKU_ID,
            ownerAccountId: itemAccountId,
          },
          select: { id: true },
        });

        const baseProduct = existingBase
          ? await prisma.product.update({
              where: { id: existingBase.id },
              data: {
                monitorMode: 'CART',
                ownerAccountId: itemAccountId,
                url: item.url,
                isActive: true,
                lastError: null,
              },
            })
          : await prisma.product.create({
              data: {
                taobaoId: item.taobaoId,
                skuId: CART_BASE_SKU_ID,
                monitorMode: 'CART',
                ownerAccountId: itemAccountId,
                url: item.url,
                isActive: true,
              },
            });

        itemStatus.productId = baseProduct.id;
        alreadyMonitoredByTaobaoId.set(itemTaobaoId, baseProduct.id);

        const successResults = (result.results || []).filter((r: any) => r && r.success);
        const wantedNumericSkuIds = new Set(
          successResults.map((r: any) => String(r.skuId || '').trim()).filter((id: string) => isDigits(id))
        );

        const metaBySkuId = new Map<string, any>();
        const metaByProps = new Map<string, any>();
        for (const r of successResults) {
          metaBySkuId.set(String(r.skuId || '').trim(), r);
          metaByProps.set(normalizeSkuProperties(r.skuProperties), r);
        }

        let matched: any[] = result.cartProducts || [];
        if (matched.length === 0) {
          await job.log(`[${item.index}] cartProducts 为空，尝试 scrapeCart...`);
          let lastCartError: string | null = null;

          for (let retry = 0; retry < 3; retry++) {
            const cart = agentIdToUse && agentHub.isConnected(agentIdToUse)
              ? await agentHub.call<any>(
                  agentIdToUse,
                  'scrapeCart',
                  { accountId: itemAccountId, cookies: account.cookies, delayScale: humanDelayScale, expectedTaobaoIds: [item.taobaoId] },
                  { timeoutMs: 10 * 60 * 1000 }
                )
              : await cartScraper.scrapeCart(itemAccountId, account.cookies, { expectedTaobaoIds: [item.taobaoId] });

            if (!cart.success) {
              lastCartError = cart.error || 'scrapeCart failed';
            } else {
              try {
                const cartSkuLoaded = Array.isArray(cart.products) ? cart.products.length : 0;
                const cartSkuTotalRaw = (cart as any)?.uiTotalCount;
                const cartSkuTotal =
                  typeof cartSkuTotalRaw === 'number' && Number.isFinite(cartSkuTotalRaw) ? cartSkuTotalRaw : null;
                setCartSkuStats(itemAccountId, { cartSkuTotal, cartSkuLoaded });
              } catch {}

              let list = cart.products.filter((p: any) => String(p.taobaoId) === String(item.taobaoId));
              if (wantedNumericSkuIds.size > 0) {
                list = list.filter((p: any) => wantedNumericSkuIds.has(String(p.skuId)));
              }
              matched = list;
              if (matched.length > 0) break;
            }
            await sleep(1500);
          }

          if (matched.length === 0) {
            const missingMessage = `未能获取购物车价格/图片: ${lastCartError ?? 'unknown'}`;
            await job.log(`[${item.index}] ${missingMessage}`);
            await prisma.product
              .update({
                where: { id: baseProduct.id },
                data: {
                  lastCheckAt: new Date(),
                  lastError: missingMessage,
                },
              })
              .catch(() => {});
          }
        }

        if (matched.length > 0) {
          const variants = matched.map((c: any) => {
            const skuId = String(c.skuId || '').trim();
            const props = normalizeSkuProperties(c.skuProperties);
            const meta = metaBySkuId.get(skuId) || metaByProps.get(props) || null;
            const selections = Array.isArray(meta?.selections) ? meta.selections : [];
            const vidPath = selections.map((s: any) => s?.vid).filter(Boolean).map((x: any) => String(x)).join(';');

            return {
              skuId: skuId || null,
              skuProperties: meta?.skuProperties ?? c.skuProperties ?? null,
              vidPath,
              selections,
              finalPrice: typeof c.finalPrice === 'number' ? c.finalPrice : null,
              originalPrice: typeof c.originalPrice === 'number' ? c.originalPrice : null,
              thumbnailUrl: c.imageUrl || meta?.thumbnailUrl || null,
            };
          });

          const prices = variants.map((v: any) => v.finalPrice).filter((n: any) => typeof n === 'number' && n > 0);
          const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
          const origs = variants.map((v: any) => v.originalPrice).filter((n: any) => typeof n === 'number' && n > 0);
          const minOrig = origs.length > 0 ? Math.min(...origs) : null;
          const first = matched[0];

          await prisma.product.update({
            where: { id: baseProduct.id },
            data: {
              title: first?.title || undefined,
              imageUrl: first?.imageUrl || undefined,
              currentPrice: minPrice,
              originalPrice: minOrig ?? undefined,
              lastCheckAt: new Date(),
              lastError: null,
            },
          });

          const rawData: any = { taobaoId: item.taobaoId, source: 'cart_initial', variants, cartAddSkuLimit };
          try {
            const skuTotalRaw = (result as any)?.skuTotal;
            const skuAvailableRaw = (result as any)?.skuAvailable;
            const skuTargetRaw = (result as any)?.skuTarget;

            const skuTotalNum = typeof skuTotalRaw === 'number' ? skuTotalRaw : Number(skuTotalRaw);
            const skuAvailableNum = typeof skuAvailableRaw === 'number' ? skuAvailableRaw : Number(skuAvailableRaw);
            const skuTargetNum = typeof skuTargetRaw === 'number' ? skuTargetRaw : Number(skuTargetRaw);

            if (Number.isFinite(skuTotalNum) && skuTotalNum >= 0) rawData.skuTotal = Math.floor(skuTotalNum);
            if (Number.isFinite(skuAvailableNum) && skuAvailableNum >= 0) rawData.skuAvailable = Math.floor(skuAvailableNum);
            if (Number.isFinite(skuTargetNum) && skuTargetNum >= 0) rawData.skuTarget = Math.floor(skuTargetNum);
          } catch {}

          await prisma.priceSnapshot.create({
            data: {
              productId: baseProduct.id,
              finalPrice: minPrice,
              originalPrice: minOrig,
              accountId: itemAccountId,
              rawData,
            },
          });

          await job.log(`[${item.index}] 已写入SKU快照: ${variants.length} 个SKU`);

          await prisma.product
            .updateMany({
              where: {
                ownerAccountId: itemAccountId,
                monitorMode: 'CART',
                taobaoId: item.taobaoId,
                NOT: { skuId: CART_BASE_SKU_ID },
              },
              data: { isActive: false },
            })
            .catch(() => {});
        }

        itemStatus.status = 'completed';
        status.progress.completedItems++;
        status.progress.successItems++;
        flushBatchProgress(true);
        await job.log(`[${item.index}] 完成`);
      } catch (error: any) {
        itemStatus.status = 'failed';
        itemStatus.error = error?.message ? String(error.message) : String(error);
        status.progress.completedItems++;
        status.progress.failedItems++;
        flushBatchProgress(true);
        await job.log(`[${item.index}] 错误: ${itemStatus.error}`);
        console.error(`[BatchCartAPI] 商品 ${String(item.taobaoId)} 失败:`, error?.stack || error);
      }
    }

    const hasFailures = status.progress.failedItems > 0;
    const hasSuccess = status.progress.successItems > 0;
    status.status = hasFailures && hasSuccess ? 'partial' : hasFailures ? 'failed' : 'completed';

    await job.updateProgress(status);
    await job.log(`批量加购完成: ${status.progress.successItems}/${status.progress.totalItems} 成功`);
    console.log(
      `[Scheduler] 批量加购（账号池）完成 batchJobId=${batchJobIdText} 成功=${status.progress.successItems}/${status.progress.totalItems} 失败=${status.progress.failedItems}`
    );
    return status;
  }

  private async processCartBatchAddJob(job: Job): Promise<any> {
    const batchJobIdText = toJobIdText(job.id);
    const ownerUserIdRaw = (job.data as any)?.ownerUserId;
    const ownerUserId = typeof ownerUserIdRaw === 'string' ? ownerUserIdRaw.trim() : null;
    const useAccountPool = Boolean((job.data as any)?.useAccountPool);
    const requestedAccountIdRaw = (job.data as any)?.accountId;
    const requestedAccountId = typeof requestedAccountIdRaw === 'string' ? requestedAccountIdRaw.trim() : '';
    const items = Array.isArray((job.data as any)?.items) ? ((job.data as any).items as any[]) : [];

    if (items.length === 0 || (!useAccountPool && !requestedAccountId)) {
      throw new Error('Invalid cart-batch-add job payload');
    }

    const scraperConfig = await (prisma as any)
      .scraperConfig.findFirst({ orderBy: { updatedAt: 'desc' } })
      .catch(() => null as any);
    const humanDelayScale =
      typeof scraperConfig?.humanDelayScale === 'number' && Number.isFinite(scraperConfig.humanDelayScale)
        ? scraperConfig.humanDelayScale
        : 1;
    setHumanDelayScale(humanDelayScale);
    const cartAddSkuDelayMinMsRaw = Number((scraperConfig as any)?.cartAddSkuDelayMinMs);
    const cartAddSkuDelayMaxMsRaw = Number((scraperConfig as any)?.cartAddSkuDelayMaxMs);
    const cartAddSkuDelayMinMs = Number.isFinite(cartAddSkuDelayMinMsRaw)
      ? Math.max(0, Math.floor(cartAddSkuDelayMinMsRaw))
      : 900;
    const cartAddSkuDelayMaxMs = Number.isFinite(cartAddSkuDelayMaxMsRaw)
      ? Math.max(cartAddSkuDelayMinMs, Math.floor(cartAddSkuDelayMaxMsRaw))
      : 2200;

    const cartAddProductDelayMinMsRaw = Number((scraperConfig as any)?.cartAddProductDelayMinMs);
    const cartAddProductDelayMaxMsRaw = Number((scraperConfig as any)?.cartAddProductDelayMaxMs);
    const cartAddProductDelayMinMs = Number.isFinite(cartAddProductDelayMinMsRaw)
      ? Math.max(0, Math.floor(cartAddProductDelayMinMsRaw))
      : 0;
    const cartAddProductDelayMaxMs = Number.isFinite(cartAddProductDelayMaxMsRaw)
      ? Math.max(cartAddProductDelayMinMs, Math.floor(cartAddProductDelayMaxMsRaw))
      : cartAddProductDelayMinMs;

    const cartAddSkuLimitDefaultRaw = Number((scraperConfig as any)?.cartAddSkuLimit);
    const cartAddSkuLimitDefault = Number.isFinite(cartAddSkuLimitDefaultRaw)
      ? Math.max(0, Math.floor(cartAddSkuLimitDefaultRaw))
      : 0;
    const cartAddSkuLimitOverrideRaw = Object.prototype.hasOwnProperty.call(job.data as any, 'cartAddSkuLimit')
      ? (job.data as any).cartAddSkuLimit
      : undefined;
    const cartAddSkuLimitOverrideNum =
      cartAddSkuLimitOverrideRaw === undefined
        ? null
        : typeof cartAddSkuLimitOverrideRaw === 'number'
          ? cartAddSkuLimitOverrideRaw
          : Number(cartAddSkuLimitOverrideRaw);
    const cartAddSkuLimit =
      cartAddSkuLimitOverrideNum !== null && Number.isFinite(cartAddSkuLimitOverrideNum)
        ? Math.max(0, Math.floor(cartAddSkuLimitOverrideNum))
        : cartAddSkuLimitDefault;

    if (useAccountPool) {
      return this.processCartBatchAddJobAccountPool(job, {
        batchJobIdText,
        items,
        ownerUserId,
        preferredAccountId: requestedAccountId || null,
        humanDelayScale,
        cartAddSkuLimit,
        cartAddSkuDelayMinMs,
        cartAddSkuDelayMaxMs,
        cartAddProductDelayMinMs,
        cartAddProductDelayMaxMs,
      });
    }

    const accountId = requestedAccountId;
    const account = await prisma.taobaoAccount.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, cookies: true, agentId: true, userId: true, isActive: true },
    });

    if (!account || !account.isActive) {
      throw new Error('Account not found or inactive');
    }

    const agentIdToUse = await this.resolveAgentIdForAccount(account, ownerUserId);

    const status: any = {
      status: 'running',
      progress: {
        totalItems: items.length,
        currentIndex: 0,
        completedItems: 0,
        successItems: 0,
        failedItems: 0,
      },
      items: items.map((it) => ({
        index: it.index,
        url: it.url,
        taobaoId: it.taobaoId,
        status: 'pending',
      })),
      ownerUserId: (job.data as any)?.ownerUserId ?? null,
    };

    await job.updateProgress(status);
    await job.log(`开始批量加购: ${items.length} 个商品 delayScale=${humanDelayScale}`);
    const batchQueueStats = await getCartAddQueueStats().catch(() => null as any);
    console.log(
      `[Scheduler] 批量加购开始 batchJobId=${batchJobIdText} accountId=${accountId} 总任务=${items.length}${
        batchQueueStats ? ` ${formatCartAddQueueStats(batchQueueStats)}` : ''
      }`
    );

    const batchTaobaoIds = items
      .map((it) => String(it?.taobaoId || '').trim())
      .filter(Boolean);
    const monitoredRows = await prisma.product
      .findMany({
        where: {
          monitorMode: 'CART',
          taobaoId: { in: batchTaobaoIds },
          ...(ownerUserId ? { ownerAccount: { is: { userId: ownerUserId } } } : {}),
        },
        select: { id: true, taobaoId: true, skuId: true },
      })
      .catch(() => [] as any[]);
    const alreadyMonitoredByTaobaoId = new Map<string, string>();
    for (const row of monitoredRows as any[]) {
      const id = String(row?.id || '').trim();
      const tid = String(row?.taobaoId || '').trim();
      const skuId = String(row?.skuId || '').trim();
      if (!id || !tid) continue;
      if (!alreadyMonitoredByTaobaoId.has(tid) || skuId === CART_BASE_SKU_ID) {
        alreadyMonitoredByTaobaoId.set(tid, id);
      }
    }

    let existingCartSkus: Map<string, Set<string>> = new Map();
    let performedAgentAdd = 0;
    let lastBatchUpdateAt = 0;

    const flushBatchProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastBatchUpdateAt < 250) return;
      lastBatchUpdateAt = now;
      void job.updateProgress(status).catch(() => {});
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemStatus = status.items[i];

      const itemTaobaoId = String(item?.taobaoId || '').trim();
      status.progress.currentIndex = i;

      const existingProductId = itemTaobaoId ? alreadyMonitoredByTaobaoId.get(itemTaobaoId) ?? null : null;
      if (existingProductId) {
        itemStatus.status = 'completed';
        itemStatus.productId = existingProductId;
        itemStatus.progress = { total: 0, current: 0, success: 0, failed: 0 };

        status.progress.completedItems++;
        status.progress.successItems++;
        await job.log(`[${item.index}] 已在监控，已忽略`);
        console.log(
          `[Scheduler] 批量加购进度 batchJobId=${batchJobIdText} 当前=${i + 1}/${items.length} taobaoId=${itemTaobaoId} 已在监控，已忽略（完成=${status.progress.completedItems}/${status.progress.totalItems}）`
        );
        flushBatchProgress(true);
        continue;
      }

      if (performedAgentAdd > 0 && cartAddProductDelayMaxMs > 0) {
        const scaledMin = Math.max(0, Math.floor(cartAddProductDelayMinMs * humanDelayScale));
        const scaledMax = Math.max(scaledMin, Math.floor(cartAddProductDelayMaxMs * humanDelayScale));
        const delay = randomDelay(scaledMin, scaledMax);
        if (delay > 0) {
          await job.log(`[${item.index}] 加购防风控等待 ${delay}ms`);
          await sleep(delay);
        }
      }

      itemStatus.status = 'running';
      await job.log(`[${item.index}] 开始处理 taobaoId=${item.taobaoId}`);
      console.log(
        `[Scheduler] 批量加购进度 batchJobId=${batchJobIdText} 当前=${i + 1}/${items.length} taobaoId=${itemTaobaoId} 开始`
      );
      flushBatchProgress(true);

      try {
        setHumanDelayScale(humanDelayScale);
        const itemIndex1 = i + 1;
        let lastConsoleAt = 0;
        let lastConsoleTotal = -1;
        const logBatchSkuProgressToConsole = (progress: any) => {
          const totalRaw = typeof progress?.total === 'number' ? progress.total : Number(progress?.total);
          const currentRaw = typeof progress?.current === 'number' ? progress.current : Number(progress?.current);
          const successRaw = typeof progress?.success === 'number' ? progress.success : Number(progress?.success);
          const failedRaw = typeof progress?.failed === 'number' ? progress.failed : Number(progress?.failed);

          const total = Number.isFinite(totalRaw) ? Math.max(0, Math.floor(totalRaw)) : 0;
          const current = Number.isFinite(currentRaw) ? Math.max(0, Math.floor(currentRaw)) : 0;
          const success = Number.isFinite(successRaw) ? Math.max(0, Math.floor(successRaw)) : 0;
          const failed = Number.isFinite(failedRaw) ? Math.max(0, Math.floor(failedRaw)) : 0;
          if (total <= 0) return;

          const now = Date.now();
          const shouldLog = total !== lastConsoleTotal || now - lastConsoleAt >= 2000 || current >= total;
          if (!shouldLog) return;
          lastConsoleAt = now;
          lastConsoleTotal = total;
          console.log(
            `[Scheduler] 批量加购进度 batchJobId=${batchJobIdText} 总体=${status.progress.completedItems}/${status.progress.totalItems} 当前=${itemIndex1}/${items.length} taobaoId=${itemTaobaoId} SKU=${current}/${total} 成功=${success} 失败=${failed}`
          );
        };

        const onProgress = (progress: any, log?: string) => {
          itemStatus.progress = progress;
          flushBatchProgress();
          if (log) void job.log(`[${item.index}] ${log}`).catch(() => {});
          logBatchSkuProgressToConsole(progress);
        };

        const result = agentIdToUse
          ? await agentHub.call<any>(
              agentIdToUse,
              'addAllSkusToCart',
              {
                accountId,
                taobaoId: item.taobaoId,
                cookies: account.cookies,
                existingCartSkus: Object.fromEntries(Array.from(existingCartSkus.entries()).map(([k, v]) => [k, Array.from(v)])),
                delayScale: humanDelayScale,
                skuDelayMinMs: cartAddSkuDelayMinMs,
                skuDelayMaxMs: cartAddSkuDelayMaxMs,
                cartAddSkuLimit,
                // Backward-compatible aliases for older agents
                skuLimit: cartAddSkuLimit,
                skuDelayMs: { min: cartAddSkuDelayMinMs, max: cartAddSkuDelayMaxMs },
              },
              { timeoutMs: 30 * 60 * 1000, onProgress }
            )
          : await autoCartAdder.addAllSkusToCart(accountId, item.taobaoId, account.cookies, {
              headless: false,
              onProgress,
              existingCartSkus,
              skuLimit: cartAddSkuLimit,
              skuDelayMs: { min: cartAddSkuDelayMinMs, max: cartAddSkuDelayMaxMs },
            });
        performedAgentAdd++;

        try {
          const uiTotalCountRaw = (result as any)?.uiTotalCount;
          const uiTotalCount =
            typeof uiTotalCountRaw === 'number' && Number.isFinite(uiTotalCountRaw) ? uiTotalCountRaw : null;
          if (uiTotalCount !== null) {
            const prev = getCartSkuStats(accountId);
            const loaded = prev?.cartSkuLoaded ?? 0;
            setCartSkuStats(accountId, { cartSkuTotal: uiTotalCount, cartSkuLoaded: Math.min(loaded, uiTotalCount) });
          }
        } catch {}

        itemStatus.progress = {
          total: result.totalSkus,
          current: result.totalSkus,
          success: result.successCount,
          failed: result.failedCount,
        };

        await job.log(`[${item.index}] SKU处理完成: ${result.successCount}/${result.totalSkus}`);

        const existingBase = await prisma.product.findFirst({
          where: {
            taobaoId: item.taobaoId,
            skuId: CART_BASE_SKU_ID,
            ownerAccountId: accountId,
          },
          select: { id: true },
        });

        const baseProduct = existingBase
          ? await prisma.product.update({
              where: { id: existingBase.id },
              data: {
                monitorMode: 'CART',
                ownerAccountId: accountId,
                url: item.url,
                isActive: true,
                lastError: null,
              },
            })
          : await prisma.product.create({
              data: {
                taobaoId: item.taobaoId,
                skuId: CART_BASE_SKU_ID,
                monitorMode: 'CART',
                ownerAccountId: accountId,
                url: item.url,
                isActive: true,
              },
            });

        itemStatus.productId = baseProduct.id;

        const successResults = (result.results || []).filter((r: any) => r && r.success);
        const wantedNumericSkuIds = new Set(
          successResults.map((r: any) => String(r.skuId || '').trim()).filter((id: string) => isDigits(id))
        );

        const metaBySkuId = new Map<string, any>();
        const metaByProps = new Map<string, any>();
        for (const r of successResults) {
          metaBySkuId.set(String(r.skuId || '').trim(), r);
          metaByProps.set(normalizeSkuProperties(r.skuProperties), r);
        }

        let matched: any[] = result.cartProducts || [];
        if (matched.length === 0) {
          await job.log(`[${item.index}] cartProducts 为空，尝试 scrapeCart...`);
          let lastCartError: string | null = null;
           for (let retry = 0; retry < 3; retry++) {
             const cart = agentIdToUse
               ? await agentHub.call<any>(
                    agentIdToUse,
                    'scrapeCart',
                    { accountId, cookies: account.cookies, delayScale: humanDelayScale, expectedTaobaoIds: [item.taobaoId] },
                    { timeoutMs: 10 * 60 * 1000 }
                  )
                : await cartScraper.scrapeCart(accountId, account.cookies, { expectedTaobaoIds: [item.taobaoId] });
            if (!cart.success) {
              lastCartError = cart.error || 'scrapeCart failed';
            } else {
              let list = cart.products.filter((p: any) => String(p.taobaoId) === String(item.taobaoId));
              if (wantedNumericSkuIds.size > 0) {
                list = list.filter((p: any) => wantedNumericSkuIds.has(String(p.skuId)));
              }
              matched = list;
              if (matched.length > 0) break;
            }
            await sleep(1500);
          }

          if (matched.length === 0) {
            const missingMessage = `未能获取购物车价格/图片: ${lastCartError ?? 'unknown'}`;
            await job.log(`[${item.index}] ${missingMessage}`);
            await prisma.product
              .update({
                where: { id: baseProduct.id },
                data: {
                  lastCheckAt: new Date(),
                  lastError: missingMessage,
                },
              })
              .catch(() => {});
          }
        }

        if (matched.length > 0) {
          const variants = matched.map((c: any) => {
            const skuId = String(c.skuId || '').trim();
            const props = normalizeSkuProperties(c.skuProperties);
            const meta = metaBySkuId.get(skuId) || metaByProps.get(props) || null;
            const selections = Array.isArray(meta?.selections) ? meta.selections : [];
            const vidPath = selections.map((s: any) => s?.vid).filter(Boolean).map((x: any) => String(x)).join(';');

            return {
              skuId: skuId || null,
              skuProperties: meta?.skuProperties ?? c.skuProperties ?? null,
              vidPath,
              selections,
              finalPrice: typeof c.finalPrice === 'number' ? c.finalPrice : null,
              originalPrice: typeof c.originalPrice === 'number' ? c.originalPrice : null,
              thumbnailUrl: c.imageUrl || meta?.thumbnailUrl || null,
            };
          });

          const prices = variants.map((v: any) => v.finalPrice).filter((n: any) => typeof n === 'number' && n > 0);
          const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
          const origs = variants.map((v: any) => v.originalPrice).filter((n: any) => typeof n === 'number' && n > 0);
          const minOrig = origs.length > 0 ? Math.min(...origs) : null;
          const first = matched[0];

          await prisma.product.update({
            where: { id: baseProduct.id },
            data: {
              title: first?.title || undefined,
              imageUrl: first?.imageUrl || undefined,
              currentPrice: minPrice,
              originalPrice: minOrig ?? undefined,
              lastCheckAt: new Date(),
              lastError: null,
            },
          });

          const rawData: any = { taobaoId: item.taobaoId, source: 'cart_initial', variants, cartAddSkuLimit };
          try {
            const skuTotalRaw = (result as any)?.skuTotal;
            const skuAvailableRaw = (result as any)?.skuAvailable;
            const skuTargetRaw = (result as any)?.skuTarget;

            const skuTotalNum = typeof skuTotalRaw === 'number' ? skuTotalRaw : Number(skuTotalRaw);
            const skuAvailableNum = typeof skuAvailableRaw === 'number' ? skuAvailableRaw : Number(skuAvailableRaw);
            const skuTargetNum = typeof skuTargetRaw === 'number' ? skuTargetRaw : Number(skuTargetRaw);

            if (Number.isFinite(skuTotalNum) && skuTotalNum >= 0) rawData.skuTotal = Math.floor(skuTotalNum);
            if (Number.isFinite(skuAvailableNum) && skuAvailableNum >= 0) rawData.skuAvailable = Math.floor(skuAvailableNum);
            if (Number.isFinite(skuTargetNum) && skuTargetNum >= 0) rawData.skuTarget = Math.floor(skuTargetNum);
          } catch {}

          await prisma.priceSnapshot.create({
            data: {
              productId: baseProduct.id,
              finalPrice: minPrice,
              originalPrice: minOrig,
              accountId,
              rawData,
            },
          });

          await job.log(`[${item.index}] 已写入SKU快照: ${variants.length} 个SKU`);

          await prisma.product
            .updateMany({
              where: {
                ownerAccountId: accountId,
                monitorMode: 'CART',
                taobaoId: item.taobaoId,
                NOT: { skuId: CART_BASE_SKU_ID },
              },
              data: { isActive: false },
            })
            .catch(() => {});
        }

        itemStatus.status = 'completed';
        status.progress.completedItems++;
        status.progress.successItems++;
        flushBatchProgress(true);
        await job.log(`[${item.index}] 完成`);
        console.log(
          `[Scheduler] 批量加购进度 batchJobId=${batchJobIdText} 当前=${itemIndex1}/${items.length} taobaoId=${itemTaobaoId} 完成（完成=${status.progress.completedItems}/${status.progress.totalItems} 成功=${status.progress.successItems} 失败=${status.progress.failedItems}）`
        );
      } catch (error: any) {
        itemStatus.status = 'failed';
        itemStatus.error = error?.message ? String(error.message) : String(error);
        status.progress.completedItems++;
        status.progress.failedItems++;
        flushBatchProgress(true);
        await job.log(`[${item.index}] 错误: ${itemStatus.error}`);
        console.error(`[BatchCartAPI] 商品 ${String(item.taobaoId)} 失败:`, error?.stack || error);
        console.log(
          `[Scheduler] 批量加购进度 batchJobId=${batchJobIdText} 当前=${i + 1}/${items.length} taobaoId=${itemTaobaoId} 失败（完成=${status.progress.completedItems}/${status.progress.totalItems} 成功=${status.progress.successItems} 失败=${status.progress.failedItems}）`
        );
      }
    }

    const hasFailures = status.progress.failedItems > 0;
    const hasSuccess = status.progress.successItems > 0;
    status.status = hasFailures && hasSuccess ? 'partial' : hasFailures ? 'failed' : 'completed';

    await job.updateProgress(status);
    await job.log(`批量加购完成: ${status.progress.successItems}/${status.progress.totalItems} 成功`);
    console.log(
      `[Scheduler] 批量加购完成 batchJobId=${batchJobIdText} 成功=${status.progress.successItems}/${status.progress.totalItems} 失败=${status.progress.failedItems}`
    );
    return status;
  }

  /**
   * 处理单个商品详情页抓取任务
   */
  private async processPageScrapeJob(job: Job): Promise<ScrapeResult> {
    const { accountId, productId, taobaoId } = job.data;

    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    const logTimings = (status: string) => {
      const totalMs = Date.now() - startedAt;
      const parts = Object.entries(timings)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(
        `[Scheduler] 任务耗时 jobId=${job.id} status=${status} accountId=${accountId} taobaoId=${taobaoId} totalMs=${totalMs} ${parts}`
      );
    };
    console.log(
      `[Scheduler] 任务开始 jobId=${job.id} accountId=${accountId} productId=${productId} taobaoId=${taobaoId}`
    );

    const state = this.accountStates.get(accountId);
    if (state) {
      state.isRunning = true;
    }

    try {
      // 获取账号信息
      const fetchAccountStartAt = Date.now();
      const account = await prisma.taobaoAccount.findUnique({
        where: { id: accountId },
      });
      timings.fetchAccountMs = Date.now() - fetchAccountStartAt;

      if (!account || !account.isActive) {
        const dbStartAt = Date.now();
        await prisma.product
          .update({
            where: { id: productId },
            data: {
              lastCheckAt: new Date(),
              lastError: 'Account not available',
            },
          })
          .catch(() => {});
        timings.dbMs = Date.now() - dbStartAt;

        logTimings('accountUnavailable');
        return { success: false, error: 'Account not available' };
      }

      // 更新账号状态
      const setRunningStartAt = Date.now();
      await prisma.taobaoAccount.update({
        where: { id: accountId },
        data: { status: AccountStatus.RUNNING },
      });
      timings.setRunningMs = Date.now() - setRunningStartAt;

      // 执行抓取
      const scrapeStartAt = Date.now();
      const result = await scraper.scrapeProduct(accountId, taobaoId, account.cookies);
      timings.scrapeMs = Date.now() - scrapeStartAt;

      console.log(
        `[Scheduler] 抓取结果 jobId=${job.id} success=${result.success} needLogin=${!!result.needLogin} needCaptcha=${!!result.needCaptcha} error=${result.error ?? 'n/a'} ms=${Date.now() - startedAt}`
      );

      const variantsCount = result.success ? (result.data?.variants?.length ?? 0) : 0;
      console.log(
        `[Scheduler] 规格抓取 jobId=${job.id} accountId=${accountId} taobaoId=${taobaoId} productId=${productId} variantsCount=${variantsCount}`
      );

      // 处理结果
      if (result.success && result.data) {
        const dbStartAt = Date.now();
        // 获取之前的价格
        const product = await prisma.product.findUnique({
          where: { id: productId },
        });

        const oldPriceRaw = product?.currentPrice ? parseFloat(product.currentPrice.toString()) : null;
        const oldPrice = typeof oldPriceRaw === 'number' && Number.isFinite(oldPriceRaw) ? oldPriceRaw : null;
        const variantPrices = (result.data.variants ?? [])
          .map((v) => v.finalPrice)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        const minVariantPrice = variantPrices.length > 0 ? Math.min(...variantPrices) : null;
        const newPriceCandidate = result.data.finalPrice ?? minVariantPrice;
        const newPrice =
          typeof newPriceCandidate === 'number' && Number.isFinite(newPriceCandidate) ? newPriceCandidate : null;

        // 保存价格快照
        if (newPrice !== null) {
          const snapshot = await prisma.priceSnapshot.create({
            data: {
              productId,
              finalPrice: newPrice,
              originalPrice: result.data.originalPrice,
              couponInfo: result.data.couponInfo,
              promotionInfo: result.data.promotionInfo,
              rawData: result.data.variants ? ({ variants: result.data.variants } as any) : undefined,
              accountId,
            },
          });

          console.log(
            `[Scheduler] 快照已保存 jobId=${job.id} productId=${productId} snapshotId=${snapshot.id} variantsSaved=${result.data.variants ? (result.data.variants.length ?? 0) : 0}`
          );

          // 更新商品信息
          await prisma.product.update({
            where: { id: productId },
            data: {
              title: result.data.title || undefined,
              imageUrl: result.data.imageUrl || undefined,
              currentPrice: newPrice,
              originalPrice: result.data.originalPrice,
              lastCheckAt: new Date(),
              lastError: null,
            },
          });

          // 检查是否需要发送通知
          if (oldPrice !== null && newPrice !== oldPrice) {
            const drop = calculatePriceDrop(oldPrice, newPrice);
            await this.checkAndNotify(productId, oldPrice, newPrice, drop, account.userId);
          }
        }

        // 重置账号错误计数
        await prisma.taobaoAccount.update({
          where: { id: accountId },
          data: {
            status: AccountStatus.IDLE,
            errorCount: 0,
            lastError: null,
          },
        });

        this.clearRiskPause();

        timings.dbMs = Date.now() - dbStartAt;

      } else if (result.needCaptcha) {
        const dbStartAt = Date.now();
        await prisma.taobaoAccount.update({
          where: { id: accountId },
          data: {
            status: AccountStatus.CAPTCHA,
            isActive: false,
            lastError: result.error || 'Captcha required',
            lastErrorAt: new Date(),
          },
        });
        await prisma.product.update({
          where: { id: productId },
          data: { lastError: result.error || 'Captcha required' },
        });
        timings.dbMs = Date.now() - dbStartAt;

        const pauseMs = this.setRiskPause(Date.now());
        await notificationService.sendSystemAlert(
          '账号需要验证码，已停用',
          [
            `account=${account.name}(${accountId})`,
            `taobaoId=${taobaoId}`,
            `productId=${productId}`,
            `error=${result.error || 'Captcha required'}`,
            `pauseMs=${pauseMs}`,
          ].join('\n')
        );

        logTimings('captcha');
        return result;

      } else if (result.needLogin) {
        const dbStartAt = Date.now();
        await prisma.taobaoAccount.update({
          where: { id: accountId },
          data: {
            status: AccountStatus.LOCKED,
            isActive: false,
            lastError: 'Login required',
            lastErrorAt: new Date(),
          },
        });
        await prisma.product.update({
          where: { id: productId },
          data: { lastError: 'Login required' },
        });
        timings.dbMs = Date.now() - dbStartAt;

        const pauseMs = this.setRiskPause(Date.now());
        await notificationService.sendSystemAlert(
          '账号需要重新登录，已停用',
          [
            `account=${account.name}(${accountId})`,
            `taobaoId=${taobaoId}`,
            `productId=${productId}`,
            `pauseMs=${pauseMs}`,
          ].join('\n')
        );

        logTimings('needLogin');
        return result;

      } else {
        // 其他错误
        const errorCount = (account.errorCount || 0) + 1;
        const dbStartAt = Date.now();
        await prisma.taobaoAccount.update({
          where: { id: accountId },
          data: {
            status: errorCount >= 5 ? AccountStatus.COOLDOWN : AccountStatus.IDLE,
            errorCount,
            lastError: result.error,
            lastErrorAt: new Date(),
          },
        });

        await prisma.product.update({
          where: { id: productId },
          data: { lastError: result.error },
        });

        timings.dbMs = Date.now() - dbStartAt;

        throw new Error(result.error);
      }

      logTimings('success');

      return result;

    } finally {
      if (state) {
        state.isRunning = false;
        state.lastRunAt = Date.now();
      }

      console.log(
        `[Scheduler] 任务结束 jobId=${job.id} accountId=${accountId} taobaoId=${taobaoId} ms=${Date.now() - startedAt}`
      );
    }
  }

  private async checkAndNotify(
    productId: string,
    oldPrice: number,
    newPrice: number,
    drop: { amount: number; percent: number },
    userId?: string | null
  ): Promise<void> {
    try {
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });
      if (!product) return;

      const userConfigs = await (prisma as any).userNotificationConfig.findMany({
        where: {
          ...(userId ? { userId } : {}),
          OR: [
            { emailEnabled: true },
            { wechatEnabled: true },
            { dingtalkEnabled: true },
            { feishuEnabled: true },
          ],
        },
      });

      if (!userConfigs.length) return;

      // 判断是降价还是涨价
      const isPriceDrop = newPrice < oldPrice;
      const isPriceUp = newPrice > oldPrice;

      for (const cfg of userConfigs) {
        const threshold = parseFloat(cfg.triggerValue.toString());
        
        // 降价通知判断
        const shouldNotifyDrop =
          isPriceDrop && (cfg.triggerType === 'AMOUNT'
            ? drop.amount >= threshold
            : drop.percent >= threshold);

        // 涨价通知判断（仅在用户启用了涨价通知时）
        const shouldNotifyUp =
          isPriceUp && cfg.notifyOnPriceUp && (cfg.triggerType === 'AMOUNT'
            ? Math.abs(drop.amount) >= threshold
            : Math.abs(drop.percent) >= threshold);

        if (!shouldNotifyDrop && !shouldNotifyUp) continue;

        await notificationService.sendPriceChangeNotification({
          product,
          oldPrice,
          newPrice,
          change: drop,
          config: cfg,
          isPriceUp,
        });
      }

    } catch (error) {
      console.error('[Scheduler] 通知发送失败:', error);
    }
  }

  // 手动触发单个商品抓取
  async scrapeNow(productId: string): Promise<void> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { account: true },
    });

    if (!product) {
      throw new Error('Product not found');
    }

    // 找一个可用账号
    const account = product.account;
    if (!account) {
      throw new Error('Product has no assigned account');
    }
    if (!account.isActive) {
      throw new Error('Assigned account is inactive');
    }

    await taskQueue.add(
      'scrape',
      {
        accountId: account.id,
        productId: product.id,
        taobaoId: product.taobaoId,
      },
      { priority: 1 } // 高优先级
    );
  }

  // 获取调度状态
  getStatus(): { accounts: AccountScheduleState[]; queueSize: number } {
    return {
      accounts: Array.from(this.accountStates.values()),
      queueSize: 0, // TODO: 获取队列大小
    };
  }
}

export const schedulerService = new SchedulerService();
