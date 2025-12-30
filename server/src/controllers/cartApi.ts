import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { autoCartAdder } from '../services/autoCartAdder.js';
import { cartScraper } from '../services/cartScraper.js';
import { agentHub } from '../services/agentHub.js';
import { extractTaobaoId } from '../utils/helpers.js';
import { systemAuth, requireCsrf } from '../middlewares/systemAuth.js';
import { buildVisibleAccountsWhere, getRequestScope } from '../auth/access.js';

const prisma = new PrismaClient();
const router = Router();

router.use(systemAuth(prisma));
router.use(requireCsrf);

const CART_BASE_SKU_ID = '__BASE__';

const addCartModeProductSchema = z.object({
  url: z.string().min(1),
  accountId: z.string().uuid(),
});

interface AddCartJobStatus {
  status: 'running' | 'completed' | 'failed';
  progress: {
    total: number;
    current: number;
    success: number;
    failed: number;
  };
  logs: string[];
  result?: any;
  ownerUserId?: string | null;
}

interface BatchItemStatus {
  index: number;
  url: string;
  taobaoId?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: { total: number; current: number; success: number; failed: number };
  logs: string[];
  error?: string;
  productId?: string;
}

interface BatchJobStatus {
  status: 'running' | 'completed' | 'failed' | 'partial';
  progress: {
    totalItems: number;
    currentIndex: number;
    completedItems: number;
    successItems: number;
    failedItems: number;
  };
  items: BatchItemStatus[];
  ownerUserId?: string | null;
}

const jobStatuses = new Map<string, AddCartJobStatus>();
const jobOwners = new Map<string, string | null>();

const batchJobStatuses = new Map<string, BatchJobStatus>();
const batchJobOwners = new Map<string, string | null>();

const accountQueues = new Map<string, Promise<void>>();

function enqueueForAccount(accountId: string, task: () => Promise<void>): Promise<void> {
  const currentQueue = accountQueues.get(accountId) || Promise.resolve();
  const newQueue = currentQueue.then(task).catch(() => {});
  accountQueues.set(accountId, newQueue);
  return newQueue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDigits(input: string): boolean {
  return /^\d+$/.test(String(input || '').trim());
}

function normalizeSkuProperties(input: string): string {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .replace(/[;；]+/g, ';')
    .trim();
}

router.post('/products/add-cart-mode', async (req: Request, res: Response) => {
  try {
    const { url, accountId } = addCartModeProductSchema.parse(req.body);

    const taobaoId = extractTaobaoId(url);
    if (!taobaoId) {
      return res.status(400).json({ success: false, error: 'Invalid Taobao URL' });
    }

    const account = await prisma.taobaoAccount.findFirst({
      where: { id: accountId, isActive: true, ...buildVisibleAccountsWhere(req) },
      select: { id: true, cookies: true, agentId: true, userId: true, isActive: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found or inactive' });
    }

    if (account.agentId && !agentHub.isConnected(account.agentId)) {
      return res.status(409).json({ success: false, error: `Agent offline: ${account.agentId}` });
    }

    const preferredAgentId = account.userId
      ? (await (prisma as any).systemUser.findUnique({
          where: { id: account.userId },
          select: { preferredAgentId: true },
        }))?.preferredAgentId ?? null
      : null;

    const agentIdToUse = account.agentId || (preferredAgentId && agentHub.isConnected(preferredAgentId) ? preferredAgentId : null);

    const jobId = `cart_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const scope = getRequestScope(req);
    const ownerUserId = scope.kind === 'user' ? scope.userId : null;
    jobOwners.set(jobId, ownerUserId);

    jobStatuses.set(jobId, {
      status: 'running',
      progress: { total: 0, current: 0, success: 0, failed: 0 },
      logs: [`开始处理商品 ${taobaoId}...`]
    });

    (async () => {
      try {
        const status = jobStatuses.get(jobId)!;
        status.logs.push('正在访问商品页面...');

        const onProgress = (progress: any, log?: string) => {
          const currentStatus = jobStatuses.get(jobId);
          if (currentStatus) {
            currentStatus.progress = progress;
            if (log) currentStatus.logs.push(log);
          }
        };

        const result = agentIdToUse
          ? await agentHub.call<any>(
              agentIdToUse,
              'addAllSkusToCart',
              { accountId, taobaoId, cookies: account.cookies },
              { timeoutMs: 30 * 60 * 1000, onProgress }
            )
          : await autoCartAdder.addAllSkusToCart(accountId, taobaoId, account.cookies, {
              headless: false,
              onProgress,
            });

        console.log(`[CartAPI] Job ${jobId} - addAllSkusToCart completed, result:`, JSON.stringify({
          taobaoId: result.taobaoId,
          totalSkus: result.totalSkus,
          successCount: result.successCount,
          failedCount: result.failedCount
        }));

        status.status = 'completed';
        status.progress = {
          total: result.totalSkus,
          current: result.totalSkus,
          success: result.successCount,
          failed: result.failedCount
        };
        status.result = result;
        status.logs.push(`完成！成功 ${result.successCount}/${result.totalSkus} 个SKU`);

        // 购物车模式：同一个 taobaoId + 账号，只保留 1 条 base Product 记录（SKU 数据写到 snapshot.variants）
        // 注意：避免依赖 Prisma “复合唯一 where 名称”，用 findFirst + update/create 更稳健
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

        // 首次加购：使用 result.cartProducts（已在同一浏览器中抓取），无需再调用 scrapeCart
        status.logs.push('正在处理购物车数据...');

        const successResults = result.results.filter((r: any) => r && r.success);
        const wantedNumericSkuIds = new Set(
          successResults.map((r: any) => String(r.skuId || '').trim()).filter((id: string) => isDigits(id))
        );

        const metaBySkuId = new Map<string, any>();
        const metaByProps = new Map<string, any>();
        for (const r of successResults) {
          metaBySkuId.set(String(r.skuId || '').trim(), r);
          metaByProps.set(normalizeSkuProperties(r.skuProperties), r);
        }

        // 直接使用 autoCartAdder 返回的购物车数据，无需再开新浏览器抓取
        let matched: any[] = result.cartProducts || [];
        console.log(`[CartAPI] Using cartProducts from result: ${matched.length} items`);

        // 如果 cartProducts 为空，降级到调用 scrapeCart（兼容旧逻辑）
        if (matched.length === 0) {
          console.log('[CartAPI] cartProducts empty, falling back to scrapeCart...');
          status.logs.push('购物车数据为空，尝试重新抓取...');
          
          let lastCartError: string | null = null;
          for (let i = 0; i < 3; i++) {
            const cart = agentIdToUse
              ? await agentHub.call<any>(
                  agentIdToUse,
                  'scrapeCart',
                  { accountId, cookies: account.cookies },
                  { timeoutMs: 120000 }
                )
              : await cartScraper.scrapeCart(accountId, account.cookies);
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
            status.logs.push(`未能从购物车获取SKU价格/图片：${lastCartError ?? 'unknown'}`);
            await prisma.product.update({
              where: { id: baseProduct.id },
              data: { lastError: `首次加购完成，但未抓到购物车价格/图片：${lastCartError ?? 'unknown'}` }
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
              thumbnailUrl: c.imageUrl || meta?.thumbnailUrl || null
            };
          });

          const prices = variants
            .map((v: any) => v.finalPrice)
            .filter((n: any) => typeof n === 'number' && n > 0);
          const minPrice = prices.length > 0 ? Math.min(...prices) : 0;

          const origs = variants
            .map((v: any) => v.originalPrice)
            .filter((n: any) => typeof n === 'number' && n > 0);
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
              lastError: null
            }
          });

          await prisma.priceSnapshot.create({
            data: {
              productId: baseProduct.id,
              finalPrice: minPrice,
              originalPrice: minOrig,
              accountId,
              rawData: { taobaoId, source: 'cart_initial', variants } as any
            }
          });

          status.logs.push(`已写入SKU快照：${variants.length} 个SKU`);

          // 隐藏旧的“每SKU一条记录”数据（避免监控列表重复显示）
          await prisma.product
            .updateMany({
              where: {
                ownerAccountId: accountId,
                monitorMode: 'CART',
                taobaoId,
                NOT: { skuId: CART_BASE_SKU_ID }
              },
              data: { isActive: false }
            })
            .catch(() => {});
        }

        console.log(`[CartAPI] Job ${jobId} completed: ${result.successCount}/${result.totalSkus} success, product saved to DB`);
      } catch (error: any) {
        const status = jobStatuses.get(jobId)!;
        status.status = 'failed';
        status.logs.push(`错误: ${error.message}`);
        console.error(`[CartAPI] Job ${jobId} failed:`, error.stack || error);
      }
    })();

    res.json({
      success: true,
      data: {
        jobId,
        estimatedTime: 60
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.get('/products/add-progress/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    const status = jobStatuses.get(jobId);
    const scope = getRequestScope(req);
    if (scope.kind === 'user' && jobOwners.get(jobId) !== scope.userId) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    if (!status) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({ success: true, data: status });

    if (status.status === 'completed' || status.status === 'failed') {
      setTimeout(() => {
        jobStatuses.delete(jobId);
        jobOwners.delete(jobId);
      }, 60000);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ============ 批量添加商品 ============

const batchAddCartModeSchema = z.object({
  urls: z.array(z.string().min(1)).min(1).max(100),
  accountId: z.string().uuid(),
});

router.post('/products/batch-add-cart-mode', async (req: Request, res: Response) => {
  try {
    const { urls, accountId } = batchAddCartModeSchema.parse(req.body);

    const account = await prisma.taobaoAccount.findFirst({
      where: { id: accountId, isActive: true, ...buildVisibleAccountsWhere(req) },
      select: { id: true, cookies: true, agentId: true, userId: true, isActive: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found or inactive' });
    }

    if (account.agentId && !agentHub.isConnected(account.agentId)) {
      return res.status(409).json({ success: false, error: `Agent offline: ${account.agentId}` });
    }

    const preferredAgentId = account.userId
      ? (await (prisma as any).systemUser.findUnique({
          where: { id: account.userId },
          select: { preferredAgentId: true },
        }))?.preferredAgentId ?? null
      : null;

    const agentIdToUse = account.agentId || (preferredAgentId && agentHub.isConnected(preferredAgentId) ? preferredAgentId : null);

    const accepted: { index: number; url: string; taobaoId?: string }[] = [];
    const rejected: { index: number; url: string; reason: string }[] = [];
    const seenTaobaoIds = new Set<string>();

    urls.forEach((url, index) => {
      const taobaoId = extractTaobaoId(url);
      if (!taobaoId) {
        rejected.push({ index, url, reason: 'Invalid URL format' });
      } else if (seenTaobaoIds.has(taobaoId)) {
        rejected.push({ index, url, reason: 'Duplicate taobaoId' });
      } else {
        seenTaobaoIds.add(taobaoId);
        accepted.push({ index, url, taobaoId });
      }
    });

    if (accepted.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid URLs provided', rejected });
    }

    const batchJobId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const scope = getRequestScope(req);
    const ownerUserId = scope.kind === 'user' ? scope.userId : null;
    batchJobOwners.set(batchJobId, ownerUserId);

    const items: BatchItemStatus[] = accepted.map((item, idx) => ({
      index: item.index,
      url: item.url,
      taobaoId: item.taobaoId,
      status: 'pending' as const,
      logs: [],
    }));

    batchJobStatuses.set(batchJobId, {
      status: 'running',
      progress: {
        totalItems: accepted.length,
        currentIndex: 0,
        completedItems: 0,
        successItems: 0,
        failedItems: 0,
      },
      items,
      ownerUserId,
    });

    (async () => {
      const batchStatus = batchJobStatuses.get(batchJobId)!;

      // 注意：不在这里预抓取购物车，因为 autoCartAdder 会自己管理浏览器
      // 预抓取会导致打开两个浏览器（cartScraper 一个，autoCartAdder 一个）
      // autoCartAdder 内部已经有检查已存在 SKU 的逻辑
      let existingCartSkus: Map<string, Set<string>> = new Map();

      for (let i = 0; i < accepted.length; i++) {
        const item = accepted[i];
        const itemStatus = batchStatus.items[i];
        
        batchStatus.progress.currentIndex = i;
        itemStatus.status = 'running';
        itemStatus.logs.push(`开始处理商品 ${item.taobaoId}...`);

        await enqueueForAccount(accountId, async () => {
          try {
            const onProgress = (progress: any, log?: string) => {
              itemStatus.progress = progress;
              if (log) itemStatus.logs.push(log);
            };

            itemStatus.logs.push('正在访问商品页面...');

            const result = agentIdToUse
              ? await agentHub.call<any>(
                  agentIdToUse,
                  'addAllSkusToCart',
                  { accountId, taobaoId: item.taobaoId, cookies: account.cookies, existingCartSkus: Object.fromEntries(
                    Array.from(existingCartSkus.entries()).map(([k, v]) => [k, Array.from(v)])
                  ) },
                  { timeoutMs: 30 * 60 * 1000, onProgress }
                )
              : await autoCartAdder.addAllSkusToCart(accountId, item.taobaoId!, account.cookies, {
                  headless: false,
                  onProgress,
                  existingCartSkus,
                });

            itemStatus.progress = {
              total: result.totalSkus,
              current: result.totalSkus,
              success: result.successCount,
              failed: result.failedCount,
            };
            itemStatus.logs.push(`SKU处理完成: ${result.successCount}/${result.totalSkus}`);

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
                    taobaoId: item.taobaoId!,
                    skuId: CART_BASE_SKU_ID,
                    monitorMode: 'CART',
                    ownerAccountId: accountId,
                    url: item.url,
                    isActive: true,
                  },
                });

            itemStatus.productId = baseProduct.id;

            const successResults = result.results.filter((r: any) => r && r.success);
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
              itemStatus.logs.push('购物车数据为空，尝试重新抓取...');
              let lastCartError: string | null = null;
              for (let retry = 0; retry < 3; retry++) {
                const cart = agentIdToUse
                  ? await agentHub.call<any>(
                      agentIdToUse,
                      'scrapeCart',
                      { accountId, cookies: account.cookies },
                      { timeoutMs: 120000 }
                    )
                  : await cartScraper.scrapeCart(accountId, account.cookies);
                if (!cart.success) {
                  lastCartError = cart.error || 'scrapeCart failed';
                } else {
                  let items = cart.products.filter((p: any) => String(p.taobaoId) === String(item.taobaoId));
                  if (wantedNumericSkuIds.size > 0) {
                    items = items.filter((p: any) => wantedNumericSkuIds.has(String(p.skuId)));
                  }
                  matched = items;
                  if (matched.length > 0) break;
                }
                await sleep(1500);
              }
              if (matched.length === 0) {
                itemStatus.logs.push(`未能获取购物车价格: ${lastCartError ?? 'unknown'}`);
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

              await prisma.priceSnapshot.create({
                data: {
                  productId: baseProduct.id,
                  finalPrice: minPrice,
                  originalPrice: minOrig,
                  accountId,
                  rawData: { taobaoId: item.taobaoId, source: 'cart_initial', variants } as any,
                },
              });

              itemStatus.logs.push(`已写入SKU快照: ${variants.length} 个SKU`);

              await prisma.product.updateMany({
                where: {
                  ownerAccountId: accountId,
                  monitorMode: 'CART',
                  taobaoId: item.taobaoId,
                  NOT: { skuId: CART_BASE_SKU_ID },
                },
                data: { isActive: false },
              }).catch(() => {});
            }

            itemStatus.status = 'completed';
            itemStatus.logs.push('完成');
            batchStatus.progress.completedItems++;
            batchStatus.progress.successItems++;

          } catch (error: any) {
            itemStatus.status = 'failed';
            itemStatus.error = error.message;
            itemStatus.logs.push(`错误: ${error.message}`);
            batchStatus.progress.completedItems++;
            batchStatus.progress.failedItems++;
            console.error(`[BatchCartAPI] Item ${item.taobaoId} failed:`, error.stack || error);
          }
        });
      }

      const hasFailures = batchStatus.progress.failedItems > 0;
      const hasSuccess = batchStatus.progress.successItems > 0;
      batchStatus.status = hasFailures && hasSuccess ? 'partial' : hasFailures ? 'failed' : 'completed';

      // 批量任务完成后保留浏览器（购物车页面），让用户可以查看结果
      console.log(`[BatchCartAPI] Batch ${batchJobId} completed: ${batchStatus.progress.successItems}/${batchStatus.progress.totalItems} success, keeping browser open`);

      setTimeout(() => {
        batchJobStatuses.delete(batchJobId);
        batchJobOwners.delete(batchJobId);
      }, 300000);
    })();

    res.json({
      success: true,
      data: {
        batchJobId,
        accepted: accepted.length,
        rejected: rejected.length,
        rejectedItems: rejected,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.get('/products/batch-add-progress/:batchJobId', async (req: Request, res: Response) => {
  try {
    const { batchJobId } = req.params;

    const status = batchJobStatuses.get(batchJobId);
    const scope = getRequestScope(req);
    if (scope.kind === 'user' && batchJobOwners.get(batchJobId) !== scope.userId) {
      return res.status(404).json({ success: false, error: 'Batch job not found' });
    }

    if (!status) {
      return res.status(404).json({ success: false, error: 'Batch job not found' });
    }

    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.post('/cart/scrape/:accountId', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;

    const account = await prisma.taobaoAccount.findFirst({
      where: { id: accountId, ...buildVisibleAccountsWhere(req) }
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    if (account.agentId && !agentHub.isConnected(account.agentId)) {
      return res.status(409).json({ success: false, error: `Agent offline: ${account.agentId}` });
    }

    const preferredAgentId = !account.agentId && account.userId
      ? (await (prisma as any).systemUser.findUnique({
          where: { id: account.userId },
          select: { preferredAgentId: true },
        }))?.preferredAgentId ?? null
      : null;

    const agentIdToUse = account.agentId || (preferredAgentId && agentHub.isConnected(preferredAgentId) ? preferredAgentId : null);

    let result;
    if (agentIdToUse) {
      const cart = await agentHub.call<any>(
        agentIdToUse,
        'scrapeCart',
        { accountId, cookies: account.cookies },
        { timeoutMs: 120000 }
      );
      result = await cartScraper.updatePricesFromCart(accountId, account.cookies, { cartResult: cart });
    } else {
      result = await cartScraper.updatePricesFromCart(accountId, account.cookies);
    }

    res.json({
      success: true,
      data: {
        updated: result.updated,
        failed: result.failed
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.get('/cart/products/:accountId', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;

    const account = await prisma.taobaoAccount.findFirst({
      where: { id: accountId, ...buildVisibleAccountsWhere(req) },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    const products = await prisma.product.findMany({
      where: {
        ownerAccountId: accountId,
        monitorMode: 'CART',
        skuId: CART_BASE_SKU_ID,
        isActive: true
      },
      include: {
        snapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 30
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, data: products });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
