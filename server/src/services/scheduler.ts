import { Queue, Worker, Job } from 'bullmq';
import { PrismaClient, AccountStatus } from '@prisma/client';
import { config } from '../config/index.js';
import { scraper, ScrapeResult } from './scraper.js';
import { cartScraper } from './cartScraper.js';
import { agentHub } from './agentHub.js';
import { notificationService } from './notification.js';
import { randomDelay, sleep, calculatePriceDrop, encryptCookies } from '../utils/helpers.js';
import IORedis from 'ioredis';

const prisma = new PrismaClient();

const CART_BASE_SKU_ID = '__BASE__';

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

  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log('[Scheduler] Starting...');
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

  /**
   * 购物车模式批量抓取调度
   * 随机间隔策略：配置间隔 × (0.5~1.5 随机系数)
   * 例如配置60分钟，实际执行间隔在30~90分钟之间
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

        // 计算随机间隔范围：0.5~1.5 倍
        const minInterval = defaultIntervalMs * 0.5;

        if (sampleProduct.lastCheckAt) {
          const timeSinceLastCheck = nowMs - sampleProduct.lastCheckAt.getTime();

          // 如果还没到最小间隔（0.5倍），跳过
          if (timeSinceLastCheck < minInterval) {
            continue;
          }

          // 使用确定性随机数：基于 accountId 和 lastCheckAt 生成固定的随机系数
          const seed = this.simpleHash(account.id + sampleProduct.lastCheckAt.getTime());
          const randomFactor = 0.5 + (seed % 100) / 100; // 0.5 ~ 1.5
          const targetInterval = defaultIntervalMs * randomFactor;

          // 如果还没到目标时间，跳过
          if (timeSinceLastCheck < targetInterval) {
            continue;
          }
        }

        // 使用 bucket 去重（避免在同一周期内重复添加任务）
        const bucket = Math.floor(nowMs / defaultIntervalMs);
        const jobId = `cart_scrape_${account.id}_${bucket}`;

        try {
          await scrapeQueue.add(
            'cart-scrape',
            {
              accountId: account.id,
              productCount: cartProductsCount
            },
            {
              jobId,
              removeOnComplete: true,
              attempts: 2,
              backoff: {
                type: 'exponential',
                delay: 30000
              }
            }
          );

          console.log(`[Scheduler] Scheduled cart scrape for account ${account.id} (${cartProductsCount} products)`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 静默跳过已存在的任务（避免日志污染）
          if (!message.toLowerCase().includes('already exists')) {
            console.error(`[Scheduler] Error scheduling cart scrape for ${account.id}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('[Scheduler] Error in scheduleCartScraping:', error);
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
      const scraperConfig = await (prisma as any).scraperConfig.findFirst();
      const quietNow = this.isWithinQuietHours(new Date(nowMs), scraperConfig);
      if (quietNow) {
        if (!this.isQuietPaused) {
          console.log(
            `[Scheduler] Quiet hours active (${String(scraperConfig?.quietHoursStart || '')}-${String(scraperConfig?.quietHoursEnd || '')}), skipping scheduling`
          );
        }
        this.isQuietPaused = true;
        return;
      }
      if (this.isQuietPaused) {
        console.log('[Scheduler] Quiet hours ended, resuming scheduling');
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
      console.error('[Scheduler] Error in scheduleTasks:', error);
    }
  }

  private async processJob(job: Job): Promise<any> {
    // 判断任务类型
    if (job.name === 'cart-scrape') {
      return this.processCartScrapeJob(job);
    }

    console.log(`[Scheduler] Unsupported job: ${job.name} id=${job.id}`);
    return { success: false, error: 'Unsupported job' };
  }

  /**
   * 处理购物车批量抓取任务
   */
  private async processCartScrapeJob(job: Job): Promise<{ success: boolean; updated: number; failed: number; missing: number }> {
    const { accountId, productCount } = job.data;
    console.log(`[Scheduler] Cart scrape start accountId=${accountId} products=${productCount}`);

    try {
      const scraperConfig = await (prisma as any).scraperConfig.findFirst();
      if (this.isWithinQuietHours(new Date(), scraperConfig)) {
        console.log(`[Scheduler] Quiet hours active, skip cart scrape accountId=${accountId}`);
        return { success: true, updated: 0, failed: 0, missing: 0 };
      }

      const account = await prisma.taobaoAccount.findUnique({
        where: { id: accountId },
        select: { id: true, name: true, cookies: true, agentId: true, userId: true }
      });

      if (!account) {
        throw new Error('Account not found');
      }

      const preferredAgentId = !account.agentId && account.userId
        ? (await (prisma as any).systemUser.findUnique({
            where: { id: account.userId },
            select: { preferredAgentId: true },
          }))?.preferredAgentId ?? null
        : null;

      const agentIdToUse = account.agentId || preferredAgentId;

      let result;
      if (agentIdToUse && agentHub.isConnected(agentIdToUse)) {
        const cart = await agentHub.call<any>(
          agentIdToUse,
          'scrapeCart',
          { accountId, cookies: account.cookies },
          { timeoutMs: 120000 }
        );
        result = await cartScraper.updatePricesFromCart(accountId, account.cookies, { cartResult: cart });
      } else {
        // 执行购物车批量抓取（本机执行，兼容未启用 Agent 的场景）
        result = await cartScraper.updatePricesFromCart(accountId, account.cookies);
      }

      console.log(`[Scheduler] Cart scrape complete accountId=${accountId} updated=${result.updated} missing=${result.missing} failed=${result.failed}`);

      return {
        success: true,
        updated: result.updated,
        failed: result.failed,
        missing: result.missing
      };
    } catch (error) {
      console.error(`[Scheduler] Cart scrape failed accountId=${accountId}:`, error);
      throw error;
    }
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
    const account = product.account;
    if (!account) {
      throw new Error('Product has no assigned account');
    }
    if (!account.isActive) {
      throw new Error('Assigned account is inactive');
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

  // 简单的字符串哈希函数（用于生成确定性随机数）
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
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
