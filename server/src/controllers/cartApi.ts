import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { agentHub } from '../services/agentHub.js';
import { taskQueue, taskQueueEvents } from '../services/taskQueue.js';
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

const batchAddCartModeSchema = z.object({
  urls: z.array(z.string().min(1)).min(1).max(100),
  accountId: z.string().uuid(),
});

type AddProgressStatus = 'pending' | 'running' | 'completed' | 'failed';
type BatchProgressStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial';

function toFiniteNumber(input: unknown, fallback = 0): number {
  const value = typeof input === 'number' ? input : Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function toAddProgress(input: unknown): { total: number; current: number; success: number; failed: number } {
  const value = input as any;
  return {
    total: Math.max(0, toFiniteNumber(value?.total, 0)),
    current: Math.max(0, toFiniteNumber(value?.current, 0)),
    success: Math.max(0, toFiniteNumber(value?.success, 0)),
    failed: Math.max(0, toFiniteNumber(value?.failed, 0)),
  };
}

function mapAddJobState(state: string): AddProgressStatus {
  if (state === 'active') return 'running';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  return 'pending';
}

function mapBatchJobState(state: string, progressStatus?: unknown): BatchProgressStatus {
  if (state === 'failed') return 'failed';
  if (state === 'completed') {
    if (progressStatus === 'partial') return 'partial';
    if (progressStatus === 'failed') return 'failed';
    return 'completed';
  }
  if (state === 'active') return 'running';
  return 'pending';
}

function groupItemLogs(lines: string[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const line of lines) {
    const m = /^\[(\d+)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const index = parseInt(m[1], 10);
    if (!Number.isFinite(index)) continue;
    const text = m[2];
    const list = map.get(index) ?? [];
    list.push(text);
    map.set(index, list);
  }
  return map;
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
      select: { id: true, agentId: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found or inactive' });
    }

    if (account.agentId && !agentHub.isConnected(account.agentId)) {
      return res.status(409).json({ success: false, error: `Agent offline: ${account.agentId}` });
    }

    const jobId = `cart_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const scope = getRequestScope(req);
    const ownerUserId = scope.kind === 'user' ? scope.userId : null;

    await taskQueue.add(
      'cart-add',
      { accountId, taobaoId, url, ownerUserId },
      {
        jobId,
        priority: 10,
        attempts: 1,
        keepLogs: 500,
        removeOnComplete: { age: 60 * 60, count: 500 },
        removeOnFail: { age: 24 * 60 * 60, count: 500 },
      }
    );

    res.json({
      success: true,
      data: {
        jobId,
        estimatedTime: 60,
      },
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

    const job = await taskQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const scope = getRequestScope(req);
    const ownerUserId = (job.data as any)?.ownerUserId ?? null;
    if (scope.kind === 'user' && ownerUserId !== scope.userId) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const state = await job.getState();
    const status = mapAddJobState(state);
    const progress = toAddProgress(job.progress);
    const { logs } = await taskQueue.getJobLogs(jobId, 0, -1);

    res.json({
      success: true,
      data: {
        status,
        progress,
        logs: logs.length > 0 ? logs : status === 'pending' ? ['任务已入队，等待执行...'] : [],
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.post('/products/batch-add-cart-mode', async (req: Request, res: Response) => {
  try {
    const { urls, accountId } = batchAddCartModeSchema.parse(req.body);

    const account = await prisma.taobaoAccount.findFirst({
      where: { id: accountId, isActive: true, ...buildVisibleAccountsWhere(req) },
      select: { id: true, agentId: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found or inactive' });
    }

    if (account.agentId && !agentHub.isConnected(account.agentId)) {
      return res.status(409).json({ success: false, error: `Agent offline: ${account.agentId}` });
    }

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

    await taskQueue.add(
      'cart-batch-add',
      { accountId, items: accepted, ownerUserId },
      {
        jobId: batchJobId,
        priority: 10,
        attempts: 1,
        keepLogs: 2000,
        removeOnComplete: { age: 60 * 60, count: 200 },
        removeOnFail: { age: 24 * 60 * 60, count: 200 },
      }
    );

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

    const job = await taskQueue.getJob(batchJobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Batch job not found' });
    }

    const scope = getRequestScope(req);
    const ownerUserId = (job.data as any)?.ownerUserId ?? null;
    if (scope.kind === 'user' && ownerUserId !== scope.userId) {
      return res.status(404).json({ success: false, error: 'Batch job not found' });
    }

    const state = await job.getState();
    const rawProgress = job.progress as any;
    const inferredStatus = mapBatchJobState(state, rawProgress?.status);

    const { logs } = await taskQueue.getJobLogs(batchJobId, 0, -1);
    const logsByIndex = groupItemLogs(logs);

    const itemsFromData = Array.isArray((job.data as any)?.items) ? ((job.data as any).items as any[]) : [];

    const base =
      rawProgress &&
      typeof rawProgress === 'object' &&
      rawProgress.progress &&
      typeof rawProgress.progress === 'object' &&
      Array.isArray(rawProgress.items)
        ? rawProgress
        : {
            status: inferredStatus,
            progress: {
              totalItems: itemsFromData.length,
              currentIndex: 0,
              completedItems: 0,
              successItems: 0,
              failedItems: 0,
            },
            items: itemsFromData.map((it) => ({
              index: toFiniteNumber(it?.index, 0),
              url: String(it?.url ?? ''),
              taobaoId: it?.taobaoId ? String(it.taobaoId) : undefined,
              status: 'pending',
            })),
          };

    res.json({
      success: true,
      data: {
        ...base,
        status: inferredStatus,
        items: (base.items as any[]).map((it) => ({
          ...it,
          progress: it?.progress ? toAddProgress(it.progress) : undefined,
          logs: logsByIndex.get(Number(it.index)) ?? [],
          error: it?.error ? String(it.error) : undefined,
          productId: it?.productId ? String(it.productId) : undefined,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.post('/cart/scrape/:accountId', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;

    const account = await prisma.taobaoAccount.findFirst({
      where: { id: accountId, ...buildVisibleAccountsWhere(req) },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    const jobId = `cart_scrape_manual_${accountId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const job = await taskQueue.add(
      'cart-scrape',
      { accountId, force: true, source: 'manual_cart_scrape' },
      {
        jobId,
        priority: 0,
        attempts: 1,
        keepLogs: 200,
        removeOnComplete: { age: 10 * 60, count: 200 },
        removeOnFail: { age: 60 * 60, count: 200 },
      }
    );

    try {
      const result = (await job.waitUntilFinished(taskQueueEvents, 10 * 60 * 1000)) as any;
      res.json({
        success: true,
        data: {
          updated: Math.max(0, toFiniteNumber(result?.updated, 0)),
          failed: Math.max(0, toFiniteNumber(result?.failed, 0)),
        },
      });
    } catch {
      res.json({ success: true, data: { queued: true, jobId } });
    }
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
        isActive: true,
      },
      include: {
        snapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 30,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: products });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
