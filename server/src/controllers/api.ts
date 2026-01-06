import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractTaobaoId, buildMobileUrl, encryptCookies } from '../utils/helpers.js';
import { schedulerService } from '../services/scheduler.js';
import { cartScraper } from '../services/cartScraper.js';
import { notificationService } from '../services/notification.js';
import { agentHub } from '../services/agentHub.js';
import { agentAuthService } from '../services/agentAuth.js';
import { config } from '../config/index.js';
import createAuthRouter from './auth.js';
import { getCookieValue } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { requireAdmin, requireCsrf, requireSession, systemAuth } from '../middlewares/systemAuth.js';
import { buildVisibleAccountsWhere, buildVisibleProductsWhere, getSessionUserId } from '../auth/access.js';
import { z } from 'zod';

const prisma = new PrismaClient();
const router = Router();

const CART_BASE_SKU_ID = '__BASE__';

function getSessionAuth(req: Request) {
  const auth = req.systemAuth;
  return auth && auth.kind === 'session' ? auth : null;
}

// ============ Agent 配对（无需登录：仅凭配对码兑换 token） ============
const agentRedeemSchema = z.object({
  code: z.string().min(1),
  agentId: z.string().min(1),
});

router.post('/agents/redeem', async (req: Request, res: Response) => {
  try {
    const { code, agentId } = agentRedeemSchema.parse(req.body);
    const redeemed = await agentAuthService.redeemPairCode(code, agentId);

    if (redeemed.setAsDefault) {
      try {
        await (prisma as any).systemUser.update({
          where: { id: redeemed.userId },
          data: { preferredAgentId: agentId },
        });
      } catch {}
    }

    res.json({ success: true, data: { token: redeemed.token } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors });
    }
    res
      .status(400)
      .json({ success: false, error: (error as any)?.message ? String((error as any).message) : String(error) });
  }
});

// API Key 认证中间件（可选，如果配置了 API_KEY 环境变量则启用）
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const requiredKey = config.apiKey;
  const providedKey =
    req.header('x-api-key') ||
    req.header('authorization')?.replace(/^Bearer\s+/i, '') ||
    '';

  const sid = getCookieValue(req.header('cookie'), SESSION_COOKIE_NAME);
  if (providedKey && sid) {
    res.status(400).json({ success: false, error: 'Ambiguous credentials' });
    return;
  }

  if (!providedKey) {
    next();
    return;
  }

  if (!requiredKey || providedKey !== requiredKey) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  req.systemAuth = { kind: 'apiKey' };

  next();
}

// 验证 Webhook URL 是否安全（防止 SSRF）
function isSafeWebhookUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local')) return false;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

// 所有 API 路由启用认证
function requireAdminOrApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.systemAuth?.kind === 'apiKey') {
    next();
    return;
  }
  requireAdmin(req, res, next);
}

router.use(
  '/auth',
  systemAuth(prisma, { allowApiKey: false, allowAnonymous: true }),
  requireCsrf,
  createAuthRouter(prisma)
);

router.use(requireApiKey);
router.use(systemAuth(prisma));
router.use(requireCsrf);

// ============ Agent 配对（需要登录：生成配对码） ============
const createPairCodeSchema = z.object({
  setAsDefault: z.boolean().optional(),
});

router.post('/agents/pair-code', requireSession, async (req: Request, res: Response) => {
  try {
    const auth = getSessionAuth(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { setAsDefault } = createPairCodeSchema.parse(req.body || {});
    const created = await agentAuthService.createPairCode(auth.user.id, { setAsDefault });
    res.json({ success: true, data: created });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ============ 商品管理 ============

// 获取商品列表
router.get('/products', async (req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      where: buildVisibleProductsWhere(req),
      include: {
        account: { select: { id: true, name: true } },
        ownerAccount: { select: { id: true, name: true } },
        snapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 30, // 最近30条价格记录
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const cartGroups = new Map<string, any>();
    const normalized: any[] = [];

    for (const p of products as any[]) {
      const key = `${p.taobaoId}:${p.ownerAccountId || ''}`;
      const existing = cartGroups.get(key);
      if (!existing) {
        cartGroups.set(key, p);
        continue;
      }

      const existingIsBase = existing.skuId === CART_BASE_SKU_ID;
      const nextIsBase = p.skuId === CART_BASE_SKU_ID;
      if (!existingIsBase && nextIsBase) {
        cartGroups.set(key, p);
      }
    }

    for (const p of cartGroups.values()) {
      normalized.push(p);
    }

    // cart products now only show one row per (taobaoId, ownerAccountId), prefer base row when present
    for (const p of normalized) {
      p.account = p.ownerAccount;
    }

    normalized.sort((a, b) => {
      const at = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    });

    res.json({ success: true, data: normalized });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.post('/products', async (req: Request, res: Response) => {
  try {
    return res.status(410).json({ success: false, error: '详情页抓取已移除，请使用购物车模式添加商品' });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 删除商品
router.delete('/products/:id', async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, AND: [buildVisibleProductsWhere(req)] },
      select: { id: true, taobaoId: true, monitorMode: true, ownerAccountId: true }
    });

    if (!product) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    if (product.monitorMode === 'CART' && product.ownerAccountId) {
      await prisma.product.deleteMany({
        where: {
          monitorMode: 'CART',
          ownerAccountId: product.ownerAccountId,
          taobaoId: product.taobaoId
        }
      });
    } else {
      await prisma.product.delete({
        where: { id: product.id },
      });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 手动刷新商品
router.post('/products/:id/refresh', async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, AND: [buildVisibleProductsWhere(req)] },
      select: { id: true, monitorMode: true, ownerAccountId: true }
    });

    if (!product) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    if (product.monitorMode === 'CART' && product.ownerAccountId) {
      const account = await prisma.taobaoAccount.findFirst({
        where: { id: product.ownerAccountId, ...buildVisibleAccountsWhere(req) },
        select: { id: true, cookies: true, agentId: true, userId: true }
      });
      if (!account) {
        return res.status(404).json({ success: false, error: 'Account not found' });
      }

      const preferredAgentId = account.userId
        ? (await (prisma as any).systemUser.findUnique({
            where: { id: account.userId },
            select: { preferredAgentId: true },
          }))?.preferredAgentId ?? null
        : null;

      const agentIdToUse =
        account.agentId && agentHub.isConnected(account.agentId)
          ? account.agentId
          : preferredAgentId && agentHub.isConnected(preferredAgentId)
            ? preferredAgentId
            : null;

      let result;
      if (agentIdToUse) {
        const cart = await agentHub.call<any>(
          agentIdToUse,
          'scrapeCart',
          { accountId: account.id, cookies: account.cookies },
          { timeoutMs: 120000 }
        );
        result = await cartScraper.updatePricesFromCart(account.id, account.cookies, { cartResult: cart });
      } else {
        result = await cartScraper.updatePricesFromCart(account.id, account.cookies);
      }
      return res.json({ success: true, message: `已刷新（更新${result.updated}，缺失${result.missing}，失败${result.failed}）` });
    }

    return res.status(410).json({ success: false, error: '该商品不是购物车模式，详情页抓取已移除' });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 获取商品价格历史
router.get('/products/:id/history', async (req: Request, res: Response) => {
  try {
    const { days = '30' } = req.query;
    const daysNum = parseInt(days as string, 10);

    const product = await prisma.product.findFirst({
      where: { id: req.params.id, AND: [buildVisibleProductsWhere(req)] },
      select: { id: true },
    });

    if (!product) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const snapshots = await prisma.priceSnapshot.findMany({
      where: {
        productId: req.params.id,
        capturedAt: {
          gte: new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: { capturedAt: 'asc' },
    });

    res.json({ success: true, data: snapshots });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

function getVariantKey(v: any): string | null {
  const raw = v?.variantKey ?? v?.skuId ?? v?.skuProperties ?? v?.vidPath;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

function normalizeVariantForClient(v: any) {
  return {
    variantKey: getVariantKey(v),
    skuId: v?.skuId ?? null,
    skuProperties: v?.skuProperties ?? null,
    vidPath: v?.vidPath ?? '',
    selections: Array.isArray(v?.selections)
      ? v.selections.map((s: any) => ({
          label: s?.label ?? '',
          value: s?.value ?? '',
          vid: s?.vid ?? undefined,
        }))
      : [],
    finalPrice: typeof v?.finalPrice === 'number' ? v.finalPrice : null,
    originalPrice: typeof v?.originalPrice === 'number' ? v.originalPrice : null,
    thumbnailUrl: v?.thumbnailUrl ?? null,
  };
}

router.get('/products/:id/variants/latest', async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, AND: [buildVisibleProductsWhere(req)] },
      select: { id: true },
    });

    if (!product) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const snapshots = await prisma.priceSnapshot.findMany({
      where: { productId: req.params.id },
      orderBy: { capturedAt: 'desc' },
      take: 2,
    });

    const latest = snapshots[0];
    const prev = snapshots[1];

    if (!latest) {
      res.json({ success: true, data: [] });
      return;
    }

    const latestRaw = (latest as any)?.rawData as any;
    const latestVariants = Array.isArray(latestRaw?.variants) ? latestRaw.variants : [];

    const prevRaw = (prev as any)?.rawData as any;
    const prevVariants = Array.isArray(prevRaw?.variants) ? prevRaw.variants : [];

    const prevByKey = new Map<string, any>();
    for (const v of prevVariants) {
      const key = getVariantKey(v);
      if (!key) continue;
      if (!prevByKey.has(key)) prevByKey.set(key, v);
    }

    const normalized = latestVariants
      .map((v: any) => {
        const next = normalizeVariantForClient(v);
        const pv = next.variantKey ? prevByKey.get(next.variantKey) : null;

        return {
          ...next,
          prevFinalPrice: typeof pv?.finalPrice === 'number' ? pv.finalPrice : null,
          prevCapturedAt: prev ? prev.capturedAt : null,
        };
      })
      .filter((v: any) => !!v.variantKey);

    console.log(
      `[API] variantsLatest productId=${req.params.id} snapshotId=${(latest as any)?.id ?? 'n/a'} rawVariants=${latestVariants.length} normalized=${normalized.length}`
    );

    res.json({ success: true, data: normalized });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.get('/products/:id/variants/:variantKey/history', async (req: Request, res: Response) => {
  try {
    const { days = '30' } = req.query;
    const daysNum = parseInt(days as string, 10);
    const variantKey = String(req.params.variantKey || '').trim();

    const product = await prisma.product.findFirst({
      where: { id: req.params.id, AND: [buildVisibleProductsWhere(req)] },
      select: { id: true },
    });

    if (!product) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const snapshots = await prisma.priceSnapshot.findMany({
      where: {
        productId: req.params.id,
        capturedAt: {
          gte: new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: { capturedAt: 'asc' },
    });

    const points = snapshots
      .map((s: any) => {
        const raw = s?.rawData as any;
        const variants = Array.isArray(raw?.variants) ? raw.variants : [];
        const v = variants.find((x: any) => getVariantKey(x) === variantKey);
        const finalPrice = typeof v?.finalPrice === 'number' ? v.finalPrice : null;
        if (finalPrice === null) return null;

        return {
          id: s.id,
          finalPrice,
          originalPrice: typeof v?.originalPrice === 'number' ? v.originalPrice : null,
          capturedAt: s.capturedAt,
        };
      })
      .filter(Boolean);

    console.log(
      `[API] variantHistory productId=${req.params.id} variantKey=${variantKey} days=${daysNum} snapshots=${snapshots.length} points=${points.length}`
    );

    res.json({ success: true, data: points });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ============ 账号管理 ============

// 获取在线 Agent 列表（用于将账号绑定到具体机器执行）
router.get('/agents', async (req: Request, res: Response) => {
  try {
    const agents = agentHub.listConnectedAgents();

    const auth = getSessionAuth(req);
    if (!auth) {
      return res.json({ success: true, data: agents });
    }

    const isAdmin = auth.user.role === 'admin';
    const visible = isAdmin
      ? agents
      : agents.filter((a) => a.userId === null || a.userId === auth.user.id);

    res.json({ success: true, data: visible });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 获取账号列表
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const accounts = await prisma.taobaoAccount.findMany({
      where: buildVisibleAccountsWhere(req),
      select: {
        id: true,
        name: true,
        agentId: true,
        isActive: true,
        status: true,
        lastLoginAt: true,
        lastErrorAt: true,
        lastError: true,
        errorCount: true,
        createdAt: true,
        _count: {
          select: {
            assignedProducts: true,
            ownedProducts: true,
          }
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // 合并两种商品计数
    const accountsWithTotalCount = accounts.map(acc => ({
      ...acc,
      _count: {
        products: acc._count.assignedProducts + acc._count.ownedProducts
      }
    }));

    res.json({ success: true, data: accountsWithTotalCount });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 绑定账号到某个 Agent（哪台机器执行浏览器自动化）
const updateAccountAgentSchema = z.object({
  agentId: z.string().min(1).nullable(),
});

const updatePreferredAgentSchema = z.object({
  agentId: z.string().min(1).nullable(),
});

router.put('/accounts/:id/agent', async (req: Request, res: Response) => {
  try {
    const { agentId } = updateAccountAgentSchema.parse(req.body);

    const auth = getSessionAuth(req);
    if (auth && auth.user.role !== 'admin' && agentId && agentHub.isConnected(agentId)) {
      if (!agentHub.isOwnedBy(agentId, auth.user.id)) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
    }

    const account = await prisma.taobaoAccount.findFirst({
      where: { id: req.params.id, ...buildVisibleAccountsWhere(req) },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    await prisma.taobaoAccount.update({
      where: { id: req.params.id },
      data: { agentId },
    });

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 设置当前用户的默认执行机（无需逐个绑定账号）
router.put('/me/preferred-agent', requireSession, async (req: Request, res: Response) => {
  try {
    const auth = getSessionAuth(req);
    if (!auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { agentId } = updatePreferredAgentSchema.parse(req.body);
    if (agentId && agentHub.isConnected(agentId) && !agentHub.isOwnedBy(agentId, auth.user.id)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    await (prisma as any).systemUser.update({
      where: { id: auth.user.id },
      data: { preferredAgentId: agentId },
    });

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 添加账号（预创建，等待登录）
router.post('/accounts', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    const userId = getSessionUserId(req);

    const account = await prisma.taobaoAccount.create({
      data: {
        name: name || `账号${Date.now()}`,
        cookies: '',
        isActive: false,
        userId: userId || undefined,
      },
    });

    res.json({ success: true, data: account });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 启动账号登录（返回登录页面URL，需要配合WebSocket推送）
router.post('/accounts/:id/login', async (req: Request, res: Response) => {
  try {
    const account = await prisma.taobaoAccount.findFirst({
      where: { id: req.params.id, ...buildVisibleAccountsWhere(req) },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    // 这里需要配合前端实现：
    // 1. 后端启动一个有头浏览器
    // 2. 通过WebSocket或VNC将浏览器画面传给前端
    // 3. 用户在前端完成扫码登录
    // 4. 后端保存cookies

    // 简化实现：返回登录指引
    res.json({
      success: true,
      message: '请在服务器上完成登录',
      instructions: [
        '1. SSH到服务器',
        '2. 运行 npm run login -- --account=' + account.id,
        '3. 在弹出的浏览器窗口中完成登录',
        '4. 登录成功后cookies会自动保存',
      ],
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 更新账号cookies（手动上传）
router.put('/accounts/:id/cookies', async (req: Request, res: Response) => {
  try {
    const { cookies } = req.body;

    if (!cookies || !Array.isArray(JSON.parse(cookies))) {
      return res.status(400).json({ success: false, error: 'Invalid cookies format' });
    }

    const account = await prisma.taobaoAccount.findFirst({
      where: { id: req.params.id, ...buildVisibleAccountsWhere(req) },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    await prisma.taobaoAccount.update({
      where: { id: req.params.id },
      data: {
        cookies: encryptCookies(cookies),
        isActive: true,
        lastLoginAt: new Date(),
        status: 'IDLE',
        errorCount: 0,
      },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 切换账号启用状态
router.put('/accounts/:id/toggle', async (req: Request, res: Response) => {
  try {
    const account = await prisma.taobaoAccount.findFirst({
      where: { id: req.params.id, ...buildVisibleAccountsWhere(req) },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    await prisma.taobaoAccount.update({
      where: { id: req.params.id },
      data: { isActive: !account.isActive },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 删除账号
router.delete('/accounts/:id', async (req: Request, res: Response) => {
  try {
    const account = await prisma.taobaoAccount.findFirst({
      where: { id: req.params.id, ...buildVisibleAccountsWhere(req) },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    await prisma.taobaoAccount.delete({ where: { id: account.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ============ 通知配置 ============

// 获取通知配置
router.get('/notifications/config', requireSession, async (req: Request, res: Response) => {
  try {
    const auth = getSessionAuth(req);
    if (!auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const userId = auth.user.id;
    let userConfig = await (prisma as any).userNotificationConfig.findUnique({
      where: { userId },
    });

    if (!userConfig) {
      userConfig = await (prisma as any).userNotificationConfig.create({
        data: { userId },
      });
    }

    res.json({ success: true, data: userConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 更新通知配置
const updateNotificationSchema = z.object({
  emailEnabled: z.boolean().optional(),
  emailAddress: z.string().email().optional().nullable(),
  wechatEnabled: z.boolean().optional(),
  wechatWebhook: z.string().optional().nullable(),
  dingtalkEnabled: z.boolean().optional(),
  dingtalkWebhook: z.string().optional().nullable(),
  feishuEnabled: z.boolean().optional(),
  feishuWebhook: z.string().optional().nullable(),
  triggerType: z.enum(['AMOUNT', 'PERCENT']).optional(),
  triggerValue: z.number().nonnegative().optional(),
  notifyOnPriceUp: z.boolean().optional(),
});

router.put('/notifications/config', requireSession, async (req: Request, res: Response) => {
  try {
    const data = updateNotificationSchema.parse(req.body);

    // 验证 Webhook URL 安全性
    if (data.wechatWebhook && !isSafeWebhookUrl(data.wechatWebhook)) {
      return res.status(400).json({ success: false, error: 'Unsafe webhook URL' });
    }

    if (data.dingtalkWebhook && !isSafeWebhookUrl(data.dingtalkWebhook)) {
      return res.status(400).json({ success: false, error: 'Unsafe webhook URL' });
    }

    if (data.feishuWebhook && !isSafeWebhookUrl(data.feishuWebhook)) {
      return res.status(400).json({ success: false, error: 'Unsafe webhook URL' });
    }

    const auth = getSessionAuth(req);
    if (!auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const userId = auth.user.id;
    const userConfig = await (prisma as any).userNotificationConfig.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    res.json({ success: true, data: userConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 测试通知
router.post('/notifications/test', requireSession, async (req: Request, res: Response) => {
  try {
    const auth = getSessionAuth(req);
    if (!auth) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const channelSchema = z.enum(['email', 'wechat', 'dingtalk', 'feishu']);
    const channel = channelSchema.parse(req.body.channel);
    const testConfig = req.body;

    // 验证 Webhook URL 安全性
    const webhookKeyByChannel: Record<string, string> = {
      wechat: 'wechatWebhook',
      dingtalk: 'dingtalkWebhook',
      feishu: 'feishuWebhook',
    };

    const webhookKey = webhookKeyByChannel[channel];
    if (webhookKey && testConfig[webhookKey]) {
      if (!isSafeWebhookUrl(testConfig[webhookKey])) {
        return res.status(400).json({ success: false, error: 'Unsafe webhook URL' });
      }
    }

    const result = await notificationService.testNotification(channel, testConfig);

    res.json({ success: result.success, error: result.error });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

const smtpKeys = ['smtp.host', 'smtp.port', 'smtp.user', 'smtp.pass', 'smtp.from'] as const;
const wecomKeys = ['wecom.enabled', 'wecom.corpId', 'wecom.agentId', 'wecom.secret', 'wecom.toUser'] as const;

router.get('/notifications/smtp', requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: [...smtpKeys] } },
    });

    const map = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        host: map['smtp.host'] || config.smtp.host,
        port: parseInt(map['smtp.port'] || String(config.smtp.port), 10),
        user: map['smtp.user'] || config.smtp.user,
        from: map['smtp.from'] || config.smtp.from,
        hasPass: !!(map['smtp.pass'] || config.smtp.pass),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

const updateSmtpSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  user: z.string().optional(),
  pass: z.string().optional(),
  from: z.string().optional(),
});

router.put('/notifications/smtp', requireAdmin, async (req: Request, res: Response) => {
  try {
    const data = updateSmtpSchema.parse(req.body);
    const entries: Array<{ key: (typeof smtpKeys)[number]; value: string }> = [];

    if (data.host !== undefined) entries.push({ key: 'smtp.host', value: data.host });
    if (data.port !== undefined) entries.push({ key: 'smtp.port', value: String(data.port) });
    if (data.user !== undefined) entries.push({ key: 'smtp.user', value: data.user });
    if (data.pass !== undefined) entries.push({ key: 'smtp.pass', value: data.pass });
    if (data.from !== undefined) entries.push({ key: 'smtp.from', value: data.from });

    await Promise.all(
      entries.map((row) =>
        prisma.systemConfig.upsert({
          where: { key: row.key },
          update: { value: row.value },
          create: { key: row.key, value: row.value },
        })
      )
    );

    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: [...smtpKeys] } },
    });
    const map = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        host: map['smtp.host'] || config.smtp.host,
        port: parseInt(map['smtp.port'] || String(config.smtp.port), 10),
        user: map['smtp.user'] || config.smtp.user,
        from: map['smtp.from'] || config.smtp.from,
        hasPass: !!(map['smtp.pass'] || config.smtp.pass),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: error.errors });
      return;
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

const testSmtpSchema = z.object({
  to: z.string().email(),
});

router.post('/notifications/smtp/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { to } = testSmtpSchema.parse(req.body);
    const result = await notificationService.testSmtp(to);
    res.json({ success: result.success, error: result.error });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: error.errors });
      return;
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.get('/notifications/wecom', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: [...wecomKeys] } },
    });

    const map = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const enabled =
      map['wecom.enabled'] !== undefined
        ? /^(1|true)$/i.test(map['wecom.enabled'].trim())
        : config.wecom.enabled;

    const corpId = map['wecom.corpId'] || config.wecom.corpId;
    const agentId = parseInt(map['wecom.agentId'] || String(config.wecom.agentId), 10);
    const toUser = (map['wecom.toUser'] || config.wecom.toUser || '@all').trim() || '@all';

    res.json({
      success: true,
      data: {
        enabled,
        corpId,
        agentId: Number.isFinite(agentId) ? agentId : 0,
        toUser,
        hasSecret: !!(map['wecom.secret'] || config.wecom.corpSecret),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

const updateWecomSchema = z.object({
  enabled: z.boolean().optional(),
  corpId: z.string().optional(),
  agentId: z.number().int().positive().optional(),
  secret: z.string().optional(),
  toUser: z.string().optional(),
});

router.put('/notifications/wecom', requireAdmin, async (req: Request, res: Response) => {
  try {
    const data = updateWecomSchema.parse(req.body);
    const entries: Array<{ key: (typeof wecomKeys)[number]; value: string }> = [];

    if (data.enabled !== undefined) entries.push({ key: 'wecom.enabled', value: data.enabled ? 'true' : 'false' });
    if (data.corpId !== undefined) entries.push({ key: 'wecom.corpId', value: data.corpId.trim() });
    if (data.agentId !== undefined) entries.push({ key: 'wecom.agentId', value: String(data.agentId) });
    if (data.toUser !== undefined) entries.push({ key: 'wecom.toUser', value: data.toUser.trim() });
    if (typeof data.secret === 'string' && data.secret.trim()) {
      entries.push({ key: 'wecom.secret', value: data.secret.trim() });
    }

    await Promise.all(
      entries.map((row) =>
        prisma.systemConfig.upsert({
          where: { key: row.key },
          update: { value: row.value },
          create: { key: row.key, value: row.value },
        })
      )
    );

    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: [...wecomKeys] } },
    });

    const map = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const enabled =
      map['wecom.enabled'] !== undefined
        ? /^(1|true)$/i.test(map['wecom.enabled'].trim())
        : config.wecom.enabled;

    const corpId = map['wecom.corpId'] || config.wecom.corpId;
    const agentId = parseInt(map['wecom.agentId'] || String(config.wecom.agentId), 10);
    const toUser = (map['wecom.toUser'] || config.wecom.toUser || '@all').trim() || '@all';

    res.json({
      success: true,
      data: {
        enabled,
        corpId,
        agentId: Number.isFinite(agentId) ? agentId : 0,
        toUser,
        hasSecret: !!(map['wecom.secret'] || config.wecom.corpSecret),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: error.errors });
      return;
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

router.post('/notifications/wecom/test', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await notificationService.testWecomApp();
    res.json({ success: result.success, error: result.error });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ============ 系统状态 ============

// 获取调度器状态
router.get('/system/status', async (req: Request, res: Response) => {
  try {
    const status = schedulerService.getStatus();

    const visibleProductsWhere = buildVisibleProductsWhere(req);
    const visibleAccountsWhere = buildVisibleAccountsWhere(req);

    const stats = {
      totalProducts: await prisma.product.count({ where: visibleProductsWhere }),
      activeProducts: await prisma.product.count({ where: { AND: [visibleProductsWhere, { isActive: true }] } }),
      totalAccounts: await prisma.taobaoAccount.count({ where: visibleAccountsWhere }),
      activeAccounts: await prisma.taobaoAccount.count({ where: { AND: [visibleAccountsWhere, { isActive: true }] } }),
      todaySnapshots: await prisma.priceSnapshot.count({
        where: {
          capturedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          product: { is: visibleProductsWhere as any },
        },
      }),
    };

    res.json({ success: true, data: { ...status, stats } });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 启动/停止调度器
router.post('/system/scheduler/:action', requireAdminOrApiKey, async (req: Request, res: Response) => {
  try {
    const { action } = req.params;

    if (action === 'start') {
      await schedulerService.start();
    } else if (action === 'stop') {
      await schedulerService.stop();
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ============ 抓取配置 ============

// 获取抓取配置
router.get('/scraper/config', requireAdminOrApiKey, async (req: Request, res: Response) => {
  try {
    let scraperConfig = await (prisma as any).scraperConfig.findFirst();

    if (!scraperConfig) {
      scraperConfig = await (prisma as any).scraperConfig.create({
        data: {
          minDelay: 60,
          maxDelay: 180,
          pollingInterval: 60,
        },
      });
    }

    res.json({ success: true, data: scraperConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 更新抓取配置
const updateScraperSchema = z.object({
  minDelay: z.number().min(0),
  maxDelay: z.number().min(0),
  pollingInterval: z.number().min(10),
});

router.put('/scraper/config', requireAdminOrApiKey, async (req: Request, res: Response) => {
  try {
    const data = updateScraperSchema.parse(req.body);

    if (data.minDelay > data.maxDelay) {
      return res.status(400).json({ success: false, error: '最小延迟不能大于最大延迟' });
    }

    let scraperConfig = await (prisma as any).scraperConfig.findFirst();

    if (scraperConfig) {
      scraperConfig = await (prisma as any).scraperConfig.update({
        where: { id: scraperConfig.id },
        data,
      });
    } else {
      scraperConfig = await (prisma as any).scraperConfig.create({ data });
    }

    res.json({ success: true, data: scraperConfig });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
