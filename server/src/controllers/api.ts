import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractTaobaoId, buildMobileUrl, encryptCookies } from '../utils/helpers.js';
import { schedulerService } from '../services/scheduler.js';
import { notificationService } from '../services/notification.js';
import { config } from '../config/index.js';
import createAuthRouter from './auth.js';
import { getCookieValue } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { requireAdmin, requireCsrf, requireSession, systemAuth } from '../middlewares/systemAuth.js';
import { z } from 'zod';

const prisma = new PrismaClient();
const router = Router();

function getSessionAuth(req: Request) {
  const auth = req.systemAuth;
  return auth && auth.kind === 'session' ? auth : null;
}

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
router.use(
  '/auth',
  systemAuth(prisma, { allowApiKey: false, allowAnonymous: true }),
  requireCsrf,
  createAuthRouter(prisma)
);

router.use(requireApiKey);
router.use(systemAuth(prisma));
router.use(requireCsrf);

// ============ 商品管理 ============

// 获取商品列表
router.get('/products', async (req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      include: {
        account: { select: { id: true, name: true } },
        snapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 30, // 最近30条价格记录
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: products });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 添加商品
const addProductSchema = z.object({
  input: z.string().min(1), // URL 或 ID
  accountId: z.string().optional(),
});

router.post('/products', async (req: Request, res: Response) => {
  try {
    const { input, accountId } = addProductSchema.parse(req.body);

    const taobaoId = extractTaobaoId(input);
    if (!taobaoId) {
      return res.status(400).json({ success: false, error: '无法识别的商品链接或ID' });
    }

    // 检查是否已存在
    const existing = await prisma.product.findUnique({
      where: { taobaoId },
    });

    if (existing) {
      return res.status(400).json({ success: false, error: '该商品已在监控列表中' });
    }

    // 创建商品
    const product = await prisma.product.create({
      data: {
        taobaoId,
        url: buildMobileUrl(taobaoId),
        accountId,
      },
    });

    // 立即触发一次抓取
    schedulerService.scrapeNow(product.id).catch(console.error);

    res.json({ success: true, data: product });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 删除商品
router.delete('/products/:id', async (req: Request, res: Response) => {
  try {
    await prisma.product.delete({
      where: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 手动刷新商品
router.post('/products/:id/refresh', async (req: Request, res: Response) => {
  try {
    await schedulerService.scrapeNow(req.params.id);
    res.json({ success: true, message: '已加入抓取队列' });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 获取商品价格历史
router.get('/products/:id/history', async (req: Request, res: Response) => {
  try {
    const { days = '30' } = req.query;
    const daysNum = parseInt(days as string, 10);

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

// 获取账号列表
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const accounts = await prisma.taobaoAccount.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
        status: true,
        lastLoginAt: true,
        lastErrorAt: true,
        lastError: true,
        errorCount: true,
        createdAt: true,
        _count: { select: { products: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: accounts });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 添加账号（预创建，等待登录）
router.post('/accounts', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    const account = await prisma.taobaoAccount.create({
      data: {
        name: name || `账号${Date.now()}`,
        cookies: '',
        isActive: false,
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
    const account = await prisma.taobaoAccount.findUnique({
      where: { id: req.params.id },
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
    const account = await prisma.taobaoAccount.findUnique({
      where: { id: req.params.id },
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
    await prisma.taobaoAccount.delete({
      where: { id: req.params.id },
    });
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

// ============ 系统状态 ============

// 获取调度器状态
router.get('/system/status', async (req: Request, res: Response) => {
  try {
    const status = schedulerService.getStatus();

    const stats = {
      totalProducts: await prisma.product.count(),
      activeProducts: await prisma.product.count({ where: { isActive: true } }),
      totalAccounts: await prisma.taobaoAccount.count(),
      activeAccounts: await prisma.taobaoAccount.count({ where: { isActive: true } }),
      todaySnapshots: await prisma.priceSnapshot.count({
        where: {
          capturedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    };

    res.json({ success: true, data: { ...status, stats } });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// 启动/停止调度器
router.post('/system/scheduler/:action', async (req: Request, res: Response) => {
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
router.get('/scraper/config', async (req: Request, res: Response) => {
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

router.put('/scraper/config', async (req: Request, res: Response) => {
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
