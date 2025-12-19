import { Queue, Worker, Job } from 'bullmq';
import { PrismaClient, AccountStatus } from '@prisma/client';
import { config } from '../config/index.js';
import { scraper, ScrapeResult } from './scraper.js';
import { notificationService } from './notification.js';
import { randomDelay, sleep, calculatePriceDrop, encryptCookies } from '../utils/helpers.js';
import IORedis from 'ioredis';

const prisma = new PrismaClient();

// Redis 连接
const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
});

// 任务队列
const scrapeQueue = new Queue('scrape-tasks', { connection });

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

  private isRiskPaused(nowMs: number): boolean {
    return nowMs < this.riskPauseUntilMs;
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

  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log('[Scheduler] Starting...');
    await scraper.init();

    // 初始化账号状态
    await this.initAccountStates();

    // 启动任务处理worker
    this.worker = new Worker(
      'scrape-tasks',
      async (job: Job) => {
        return this.processJob(job);
      },
      {
        connection,
        concurrency: 1, // 串行处理，避免并发风险
      }
    );

    this.worker.on('completed', (job) => {
      console.log(`[Scheduler] Job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`[Scheduler] Job ${job?.id} failed:`, err.message);
    });

    // 主调度循环
    this.isRunning = true;
    this.mainLoopInterval = setInterval(() => this.scheduleTasks(), 10000); // 每10秒检查一次
    await this.scheduleTasks(); // 立即执行一次

    console.log('[Scheduler] Started');
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

    await scraper.close();
    console.log('[Scheduler] Stopped');
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

    console.log(`[Scheduler] Initialized ${accounts.length} accounts`);
  }

  private async scheduleTasks(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const nowMs = Date.now();
      if (this.isRiskPaused(nowMs)) {
        return;
      }

      // 获取抓取配置
      const scraperConfig = await (prisma as any).scraperConfig.findFirst();
      const defaultIntervalMs = (scraperConfig?.pollingInterval ?? 60) * 60 * 1000;

      // 获取所有活跃账号
      const accounts = await prisma.taobaoAccount.findMany({
        where: {
          isActive: true,
          status: { in: [AccountStatus.IDLE, AccountStatus.RUNNING] },
        },
      });

      // 获取需要检查的商品
      const products = await prisma.product.findMany({
        where: {
          isActive: true,
        },
        orderBy: { lastCheckAt: 'asc' },
      });

      const dueProducts = products.filter((product) => {
        const intervalMs = Math.max(
          1000,
          (product.checkInterval ? product.checkInterval * 1000 : defaultIntervalMs)
        );

        if (!product.lastCheckAt) return true;
        return product.lastCheckAt.getTime() <= nowMs - intervalMs;
      });

      if (dueProducts.length === 0 || accounts.length === 0) {
        return;
      }

      const accountById = new Map(accounts.map((a) => [a.id, a] as const));
      let rr = 0;

      for (let i = 0; i < dueProducts.length; i++) {
        const product = dueProducts[i];
        const preferred = product.accountId ? accountById.get(product.accountId) : null;
        const fallback = accounts[rr % accounts.length];
        const account = preferred || fallback;
        rr += 1;

        const state = this.accountStates.get(account.id);
        if (state?.isRunning) continue;
        if (!state) {
          this.accountStates.set(account.id, {
            accountId: account.id,
            lastRunAt: 0,
            isRunning: false,
            productQueue: [],
          });
        }

        const intervalMs = Math.max(
          1000,
          (product.checkInterval ? product.checkInterval * 1000 : defaultIntervalMs)
        );
        const bucket = Math.floor(nowMs / intervalMs);
        const jobId = `scrape_${product.id}_${bucket}`;

        try {
          await scrapeQueue.add(
            'scrape',
            {
              accountId: account.id,
              productId: product.id,
              taobaoId: product.taobaoId,
            },
            {
              jobId,
              removeOnComplete: true,
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 60000,
              },
            }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.toLowerCase().includes('already exists')) {
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      console.error('[Scheduler] Error in scheduleTasks:', error);
    }
  }

  private async processJob(job: Job): Promise<ScrapeResult> {
    const { accountId, productId, taobaoId } = job.data;

    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    const logTimings = (status: string) => {
      const totalMs = Date.now() - startedAt;
      const parts = Object.entries(timings)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(
        `[Scheduler] Job ${job.id} timings status=${status} accountId=${accountId} taobaoId=${taobaoId} totalMs=${totalMs} ${parts}`
      );
    };
    console.log(
      `[Scheduler] Job ${job.id} start accountId=${accountId} productId=${productId} taobaoId=${taobaoId}`
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
        `[Scheduler] Job ${job.id} scrapeResult success=${result.success} needLogin=${!!result.needLogin} needCaptcha=${!!result.needCaptcha} error=${result.error ?? 'n/a'} ms=${Date.now() - startedAt}`
      );

      const variantsCount = result.success ? (result.data?.variants?.length ?? 0) : 0;
      console.log(
        `[Scheduler] Job ${job.id} scrapeVariants accountId=${accountId} taobaoId=${taobaoId} productId=${productId} variantsCount=${variantsCount}`
      );

      // 处理结果
      if (result.success && result.data) {
        const dbStartAt = Date.now();
        // 获取之前的价格
        const product = await prisma.product.findUnique({
          where: { id: productId },
        });

        const oldPrice = product?.currentPrice ? parseFloat(product.currentPrice.toString()) : null;
        const variantPrices = (result.data.variants ?? [])
          .map((v) => v.finalPrice)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        const minVariantPrice = variantPrices.length > 0 ? Math.min(...variantPrices) : null;
        const newPrice = result.data.finalPrice ?? minVariantPrice;

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
            `[Scheduler] Job ${job.id} snapshotSaved productId=${productId} snapshotId=${snapshot.id} variantsSaved=${result.data.variants ? (result.data.variants.length ?? 0) : 0}`
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
          if (oldPrice !== null && newPrice < oldPrice) {
            const drop = calculatePriceDrop(oldPrice, newPrice);
            await this.checkAndNotify(productId, oldPrice, newPrice, drop);
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

      // 随机延迟后继续（从数据库读取配置）
      const scraperConfig = await (prisma as any).scraperConfig.findFirst();
      const minDelayMs = (scraperConfig?.minDelay ?? 60) * 1000; // 默认60秒
      const maxDelayMs = (scraperConfig?.maxDelay ?? 180) * 1000; // 默认180秒
      const delay = randomDelay(minDelayMs, maxDelayMs);
      timings.delayTargetMs = delay;
      const delayStartAt = Date.now();
      await sleep(delay);
      timings.delayMs = Date.now() - delayStartAt;

      logTimings('success');

      return result;

    } finally {
      if (state) {
        state.isRunning = false;
        state.lastRunAt = Date.now();
      }

      console.log(
        `[Scheduler] Job ${job.id} end accountId=${accountId} taobaoId=${taobaoId} ms=${Date.now() - startedAt}`
      );
    }
  }

  private async checkAndNotify(
    productId: string,
    oldPrice: number,
    newPrice: number,
    drop: { amount: number; percent: number }
  ): Promise<void> {
    try {
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });
      if (!product) return;

      const userConfigs = await (prisma as any).userNotificationConfig.findMany({
        where: {
          OR: [
            { emailEnabled: true },
            { wechatEnabled: true },
            { dingtalkEnabled: true },
            { feishuEnabled: true },
          ],
        },
      });

      if (!userConfigs.length) return;

      for (const cfg of userConfigs) {
        const threshold = parseFloat(cfg.triggerValue.toString());
        const shouldNotify =
          cfg.triggerType === 'AMOUNT'
            ? drop.amount >= threshold
            : drop.percent >= threshold;

        if (!shouldNotify) continue;

        await notificationService.sendPriceDropNotification({
          product,
          oldPrice,
          newPrice,
          drop,
          config: cfg,
        });
      }

    } catch (error) {
      console.error('[Scheduler] Notification error:', error);
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
    const account = product.account || await prisma.taobaoAccount.findFirst({
      where: { isActive: true, status: AccountStatus.IDLE },
    });

    if (!account) {
      throw new Error('No available account');
    }

    await scrapeQueue.add(
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
