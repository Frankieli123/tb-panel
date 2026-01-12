import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { PrismaClient, Product, UserNotificationConfig } from '@prisma/client';
import { formatPrice } from '../utils/helpers.js';

const prisma = new PrismaClient();

interface PriceChangeNotification {
  product: Product;
  oldPrice: number;
  newPrice: number;
  change: { amount: number; percent: number };
  config: UserNotificationConfig;
  isPriceUp: boolean;
}

class NotificationService {
  private emailTransporter: nodemailer.Transporter | null = null;
  private smtpCacheKey: string | null = null;
  private wecomAccessToken: string | null = null;
  private wecomTokenExpiresAtMs = 0;
  private wecomTokenCacheKey: string | null = null;

  constructor() {
  }

  private async loadSmtpSettings(): Promise<{
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
  } | null> {
    const keys = ['smtp.host', 'smtp.port', 'smtp.user', 'smtp.pass', 'smtp.from'] as const;
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: [...keys] } },
    });

    const map = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const host = map['smtp.host'] || config.smtp.host;
    const port = parseInt(map['smtp.port'] || String(config.smtp.port), 10);
    const user = map['smtp.user'] || config.smtp.user;
    const pass = map['smtp.pass'] || config.smtp.pass;
    const from = map['smtp.from'] || config.smtp.from;

    if (!user || !pass) return null;

    return {
      host,
      port: Number.isFinite(port) ? port : config.smtp.port,
      user,
      pass,
      from,
    };
  }

  private parseOptionalBool(input: string | undefined): boolean | null {
    if (!input) return null;
    const v = String(input).trim().toLowerCase();
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    return null;
  }

  private async loadWecomSettings(): Promise<{
    corpId: string;
    corpSecret: string;
    agentId: number;
    toUser: string;
  } | null> {
    const keys = ['wecom.enabled', 'wecom.corpId', 'wecom.agentId', 'wecom.secret', 'wecom.toUser'] as const;
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: [...keys] } },
    });

    const map = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const enabled = this.parseOptionalBool(map['wecom.enabled']) ?? config.wecom.enabled;
    if (!enabled) return null;

    const corpId = map['wecom.corpId'] || config.wecom.corpId;
    const corpSecret = map['wecom.secret'] || config.wecom.corpSecret;
    const agentId = parseInt(map['wecom.agentId'] || String(config.wecom.agentId), 10);
    const toUser = (map['wecom.toUser'] || config.wecom.toUser || '@all').trim() || '@all';

    if (!corpId || !corpSecret || !Number.isFinite(agentId) || agentId <= 0) {
      console.warn('[Notification] 企业微信应用未完整配置');
      return null;
    }

    return { corpId, corpSecret, agentId, toUser };
  }

  private async getEmailTransport(): Promise<{ transporter: nodemailer.Transporter; from: string } | null> {
    const settings = await this.loadSmtpSettings();
    if (!settings) {
      console.warn('[Notification] 邮件发送器未配置');
      return null;
    }

    const cacheKey = JSON.stringify({
      host: settings.host,
      port: settings.port,
      user: settings.user,
      pass: settings.pass,
    });

    if (!this.emailTransporter || this.smtpCacheKey !== cacheKey) {
      this.emailTransporter = nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.port === 465,
        auth: {
          user: settings.user,
          pass: settings.pass,
        },
      });
      this.smtpCacheKey = cacheKey;
    }

    return {
      transporter: this.emailTransporter,
      from: settings.from,
    };
  }

  private async getWecomAccessToken(settings: { corpId: string; corpSecret: string }): Promise<string> {
    const cacheKey = `${settings.corpId}|${settings.corpSecret}`;
    if (this.wecomTokenCacheKey !== cacheKey) {
      this.wecomAccessToken = null;
      this.wecomTokenExpiresAtMs = 0;
      this.wecomTokenCacheKey = cacheKey;
    }

    const now = Date.now();
    if (this.wecomAccessToken && now < this.wecomTokenExpiresAtMs - 60_000) {
      return this.wecomAccessToken;
    }

    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
    url.searchParams.set('corpid', settings.corpId);
    url.searchParams.set('corpsecret', settings.corpSecret);

    const res = await fetch(url, { method: 'GET' });
    const payload = (await res.json().catch(() => null)) as any;

    if (!res.ok) {
      throw new Error(`WeCom gettoken failed HTTP ${res.status}`);
    }

    if (!payload || payload.errcode !== 0 || !payload.access_token) {
      throw new Error(`WeCom gettoken error: ${payload?.errcode ?? 'unknown'} ${payload?.errmsg ?? ''}`.trim());
    }

    const expiresInSec = typeof payload.expires_in === 'number' ? payload.expires_in : 7200;
    this.wecomAccessToken = String(payload.access_token);
    this.wecomTokenExpiresAtMs = Date.now() + expiresInSec * 1000;

    return this.wecomAccessToken;
  }

  private truncateText(input: string, maxLen: number): string {
    const text = String(input ?? '').trim();
    if (!text) return '';
    if (text.length <= maxLen) return text;
    const keep = Math.max(0, maxLen - 1);
    return `${text.slice(0, keep)}…`;
  }

  private buildWecomMonitoringUrl(productId?: string): string {
    const base = String(config.cors.origins[0] || '').trim();
    if (!base) return '';
    try {
      const url = new URL(base);
      if (productId) url.searchParams.set('productId', productId);
      return url.toString();
    } catch {
      return base;
    }
  }

  async sendPriceChangeNotification(data: PriceChangeNotification): Promise<void> {
    const { product, oldPrice, newPrice, change, config: notifyConfig, isPriceUp } = data;

    const titlePrefix = isPriceUp ? '【涨价提醒】' : '【降价提醒】';
    const title = `${titlePrefix}${product.title || '商品'}`;
    const content = this.buildNotificationContent(product, oldPrice, newPrice, change, isPriceUp);

    const promises: Promise<void>[] = [];

    // 邮件通知
    if (notifyConfig.emailEnabled && notifyConfig.emailAddress) {
      promises.push(
        this.sendEmail(notifyConfig.emailAddress, title, content, product.id)
      );
    }

    // 微信通知
    if (notifyConfig.wechatEnabled && notifyConfig.wechatWebhook) {
      promises.push(
        this.sendWechat(notifyConfig.wechatWebhook, title, content, product.id)
      );
    }

    // 钉钉通知
    if (notifyConfig.dingtalkEnabled && notifyConfig.dingtalkWebhook) {
      promises.push(this.sendDingtalk(notifyConfig.dingtalkWebhook, title, content, product.id));
    }

    // 飞书通知
    if (notifyConfig.feishuEnabled && notifyConfig.feishuWebhook) {
      promises.push(this.sendFeishu(notifyConfig.feishuWebhook, title, content, product.id));
    }

    await Promise.allSettled(promises);
  }

  async sendWecomAppPriceChangeNotification(data: Omit<PriceChangeNotification, 'config'>): Promise<void> {
    const settings = await this.loadWecomSettings();
    if (!settings) return;

    const { product, oldPrice, newPrice, change, isPriceUp } = data;

    try {
      const titlePrefix = isPriceUp ? '【涨价提醒】' : '【降价提醒】';
      const baseTitle = `${titlePrefix}${product.title || '商品'}`;

      const direction = isPriceUp ? '上涨' : '下降';
      const summary = `现价：${formatPrice(newPrice)}（原价：${formatPrice(oldPrice)}）${direction}：${formatPrice(Math.abs(change.amount))}（${Math.abs(change.percent).toFixed(1)}%）`;
      const variants = await this.buildWecomVariantItems(product.id);

      const imageUrl = product.imageUrl || 'https://www.taobao.com/favicon.ico';
      const monitoringUrl = this.buildWecomMonitoringUrl(product.id) || product.url;

      const displayedVariants = variants.slice(0, 4);
      const hasMore = variants.length > 4;

      const title = this.truncateText(baseTitle, 36);
      const desc = this.truncateText(hasMore ? `变动规格:${variants.length}（前4） ${summary}` : summary, 44);

      const card = {
        card_type: 'news_notice',
        main_title: { title, ...(desc ? { desc } : {}) },
        card_image: { url: imageUrl },
        vertical_content_list: displayedVariants.map((it) => ({ title: it.title, ...(it.desc ? { desc: it.desc } : {}) })),
        jump_list: [{ type: 1, title: '查看更多', url: monitoringUrl }],
        card_action: { type: 1, url: monitoringUrl },
      };

      const logContent = [summary, ...variants.map((it) => `${it.title}：${it.desc || ''}`)].join('\n');
      await this.sendWecomTemplateCard(settings, card, product.id, title, logContent);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(product.id, 'wecom', 'WeCom App', 'Send failed', false, errorMsg);
      console.error('[Notification] 企业微信应用错误:', errorMsg);
    }
  }

  async sendPriceDropNotification(data: {
    product: Product;
    oldPrice: number;
    newPrice: number;
    drop: { amount: number; percent: number };
    config: UserNotificationConfig;
  }): Promise<void> {
    await this.sendPriceChangeNotification({
      product: data.product,
      oldPrice: data.oldPrice,
      newPrice: data.newPrice,
      change: data.drop,
      config: data.config,
      isPriceUp: false,
    });
  }

  async sendSystemAlert(title: string, content: string): Promise<void> {
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

    const alertTitle = `【系统告警】${title}`;

    const promises: Promise<void>[] = [];
    for (const cfg of userConfigs) {
      if (cfg.emailEnabled && cfg.emailAddress) {
        promises.push(this.sendEmail(cfg.emailAddress, alertTitle, content, 'system'));
      }

      if (cfg.wechatEnabled && cfg.wechatWebhook) {
        promises.push(this.sendWechat(cfg.wechatWebhook, alertTitle, content, 'system'));
      }

      if (cfg.dingtalkEnabled && cfg.dingtalkWebhook) {
        promises.push(this.sendDingtalk(cfg.dingtalkWebhook, alertTitle, content, 'system'));
      }

      if (cfg.feishuEnabled && cfg.feishuWebhook) {
        promises.push(this.sendFeishu(cfg.feishuWebhook, alertTitle, content, 'system'));
      }
    }

    await Promise.allSettled(promises);
  }

  private buildNotificationContent(
    product: Product,
    oldPrice: number,
    newPrice: number,
    change: { amount: number; percent: number },
    isPriceUp: boolean
  ): string {
    const changeLabel = isPriceUp ? '涨幅' : '降幅';
    return `
商品：${product.title || product.taobaoId}
原价：${formatPrice(oldPrice)}
现价：${formatPrice(newPrice)}
${changeLabel}：${formatPrice(Math.abs(change.amount))} (${Math.abs(change.percent).toFixed(1)}%)
链接：${product.url}
    `.trim();
  }

  private async sendEmail(
    to: string,
    subject: string,
    text: string,
    productId: string
  ): Promise<void> {
    const transport = await this.getEmailTransport();
    if (!transport) return;

    try {
      await transport.transporter.sendMail({
        from: transport.from,
        to,
        subject,
        text,
        html: `<pre style="font-family: sans-serif;">${text}</pre>`,
      });

      await this.logNotification(productId, 'email', subject, text, true);
      console.log(`[Notification] 邮件已发送至 ${to}`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'email', subject, text, false, errorMsg);
      console.error('[Notification] 邮件发送错误:', errorMsg);
    }
  }

  private async sendWechat(
    webhookUrl: string,
    title: string,
    content: string,
    productId: string
  ): Promise<void> {
    try {
      // 支持企业微信 Webhook 和 Server酱
      const isServerChan = webhookUrl.includes('sctapi.ftqq.com') ||
                           webhookUrl.includes('sc.ftqq.com');

      let body: object;
      let url = webhookUrl;

      if (isServerChan) {
        // Server酱格式
        body = {
          title,
          desp: content.replace(/\n/g, '\n\n'), // Server酱需要双换行
        };
      } else {
        // 企业微信 Webhook 格式
        body = {
          msgtype: 'text',
          text: {
            content: `${title}\n\n${content}`,
          },
        };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await this.logNotification(productId, 'wechat', title, content, true);
      console.log('[Notification] 微信通知已发送');

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'wechat', title, content, false, errorMsg);
      console.error('[Notification] 微信发送错误:', errorMsg);
    }
  }

  private async sendDingtalk(
    webhookUrl: string,
    title: string,
    content: string,
    productId: string
  ): Promise<void> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: {
            content: `${title}\n\n${content}`,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await this.logNotification(productId, 'dingtalk', title, content, true);
      console.log('[Notification] 钉钉通知已发送');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'dingtalk', title, content, false, errorMsg);
      console.error('[Notification] 钉钉发送错误:', errorMsg);
    }
  }

  private async sendFeishu(
    webhookUrl: string,
    title: string,
    content: string,
    productId: string
  ): Promise<void> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'text',
          content: {
            text: `${title}\n\n${content}`,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await this.logNotification(productId, 'feishu', title, content, true);
      console.log('[Notification] 飞书通知已发送');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'feishu', title, content, false, errorMsg);
      console.error('[Notification] 飞书发送错误:', errorMsg);
    }
  }

  private async buildWecomVariantItems(productId: string): Promise<Array<{ title: string; desc?: string }>> {
    try {
      const snapshots = await prisma.priceSnapshot.findMany({
        where: { productId },
        orderBy: { capturedAt: 'desc' },
        take: 2,
        select: { rawData: true },
      });

      const currentRaw = snapshots[0]?.rawData as any;
      const prevRaw = snapshots[1]?.rawData as any;
      const currentVariants = Array.isArray(currentRaw?.variants) ? currentRaw.variants : [];
      const prevVariants = Array.isArray(prevRaw?.variants) ? prevRaw.variants : [];

      const keyOf = (v: any): string => String(v?.skuId ?? v?.vidPath ?? v?.skuProperties ?? '').trim();

      const labelOf = (v: any, fallbackKey: string): string => {
        const raw =
          String(v?.skuProperties ?? '').trim() ||
          String(v?.skuId ?? '').trim() ||
          String(v?.vidPath ?? '').trim() ||
          fallbackKey ||
          '规格';
        const compact = raw.replace(/\s+/g, ' ');
        return compact.length > 38 ? `${compact.slice(0, 35)}...` : compact;
      };

      const toPrice = (value: any): number | null => {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string') {
          const n = parseFloat(value);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };

      const prevByKey = new Map<string, any>();
      for (const v of prevVariants) {
        const k = keyOf(v);
        if (k && !prevByKey.has(k)) prevByKey.set(k, v);
      }

      const toCents = (n: number): number => Math.round(n * 100);

      const items: Array<{
        label: string;
        current: number;
        prev: number;
        diff: number;
      }> = [];

      for (const v of currentVariants) {
        const k = keyOf(v);
        const current = toPrice(v?.finalPrice);
        if (current === null || current <= 0) continue;
        const prev = k ? toPrice(prevByKey.get(k)?.finalPrice) : null;
        if (prev === null || prev <= 0) continue;
        const diff = (toCents(current) - toCents(prev)) / 100;
        if (diff === 0) continue;
        items.push({ label: labelOf(v, k), current, prev, diff });
      }

      if (!items.length) return [];

      items.sort((a, b) => {
        const da = Math.abs(a.diff);
        const db = Math.abs(b.diff);
        if (db !== da) return db - da;
        return a.current - b.current;
      });

      return items.map((it) => {
        const title = this.truncateText(it.label, 38);
        const arrow = it.diff > 0 ? '↑' : '↓';
        return {
          title,
          desc: `${formatPrice(it.current)}（原 ${formatPrice(it.prev)}，${arrow}${formatPrice(Math.abs(it.diff))}）`,
        };
      });
    } catch (error) {
      console.warn('[Notification] 企业微信规格摘要生成失败:', error);
      return [];
    }
  }

  private async sendWecomTemplateCard(
    settings: { corpId: string; corpSecret: string; agentId: number; toUser: string },
    templateCard: any,
    productId: string,
    logTitle: string,
    logContent: string
  ): Promise<void> {
    const sendOnce = async (): Promise<any> => {
      const accessToken = await this.getWecomAccessToken({
        corpId: settings.corpId,
        corpSecret: settings.corpSecret,
      });

      const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send');
      endpoint.searchParams.set('access_token', accessToken);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: settings.toUser || '@all',
          msgtype: 'template_card',
          agentid: settings.agentId,
          template_card: templateCard,
        }),
      });

      const payload = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        throw new Error(`WeCom message/send failed HTTP ${res.status}`);
      }
      return payload;
    };

    let payload = await sendOnce();
    if (payload && [40014, 42001, 42007, 42009].includes(payload.errcode)) {
      this.wecomAccessToken = null;
      this.wecomTokenExpiresAtMs = 0;
      payload = await sendOnce();
    }

    if (!payload || payload.errcode !== 0) {
      throw new Error(`WeCom message/send error: ${payload?.errcode ?? 'unknown'} ${payload?.errmsg ?? ''}`.trim());
    }

    await this.logNotification(productId, 'wecom', logTitle, logContent, true);
    console.log('[Notification] 企业微信应用消息已发送');
  }

  private async logNotification(
    productId: string,
    channel: string,
    title: string,
    content: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    try {
      await prisma.notificationLog.create({
        data: {
          productId,
          channel,
          title,
          content,
          success,
          error,
        },
      });
    } catch (e) {
      console.error('[Notification] 记录通知日志失败:', e);
    }
  }

  // 测试通知
  async testNotification(
    channel: 'email' | 'wechat' | 'dingtalk' | 'feishu',
    config: Partial<UserNotificationConfig>
  ): Promise<{ success: boolean; error?: string }> {
    const testTitle = '【测试通知】淘宝价格监控';
    const testContent = '这是一条测试消息，如果您收到此消息，说明通知配置正确。';
    const testProductId = 'test';

    try {
      switch (channel) {
        case 'email':
          if (!config.emailAddress) throw new Error('Email address required');
          await this.sendEmail(config.emailAddress, testTitle, testContent, testProductId);
          break;

        case 'wechat':
          if (!config.wechatWebhook) throw new Error('Webhook URL required');
          await this.sendWechat(config.wechatWebhook, testTitle, testContent, testProductId);
          break;

        case 'dingtalk':
          if (!config.dingtalkWebhook) throw new Error('Webhook URL required');
          await this.sendDingtalk(config.dingtalkWebhook, testTitle, testContent, testProductId);
          break;

        case 'feishu':
          if (!config.feishuWebhook) throw new Error('Webhook URL required');
          await this.sendFeishu(config.feishuWebhook, testTitle, testContent, testProductId);
          break;
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async testSmtp(to: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.sendEmail(to, '【SMTP测试】淘宝价格监控', '这是一条 SMTP 测试消息。', 'test');
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async testWecomApp(): Promise<{ success: boolean; error?: string }> {
    try {
      const settings = await this.loadWecomSettings();
      if (!settings) {
        return { success: false, error: 'WeCom App not configured' };
      }

      const monitoringUrl = this.buildWecomMonitoringUrl();
      const title = '【测试通知】Taobao 价格监控';
      const desc = '这是一条企业微信应用测试消息。';
      const card = {
        card_type: 'news_notice',
        main_title: { title, desc },
        card_image: { url: 'https://www.taobao.com/favicon.ico' },
        jump_list: monitoringUrl ? [{ type: 1, title: '查看更多', url: monitoringUrl }] : undefined,
        card_action: { type: 1, url: monitoringUrl || 'https://www.taobao.com/' },
      };

      await this.sendWecomTemplateCard(settings, card, 'test', title, desc);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const notificationService = new NotificationService();
