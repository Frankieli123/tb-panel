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

  private async getEmailTransport(): Promise<{ transporter: nodemailer.Transporter; from: string } | null> {
    const settings = await this.loadSmtpSettings();
    if (!settings) {
      console.warn('[Notification] Email transporter not configured');
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
      console.log(`[Notification] Email sent to ${to}`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'email', subject, text, false, errorMsg);
      console.error('[Notification] Email error:', errorMsg);
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
      console.log('[Notification] WeChat notification sent');

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'wechat', title, content, false, errorMsg);
      console.error('[Notification] WeChat error:', errorMsg);
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
      console.log('[Notification] DingTalk notification sent');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'dingtalk', title, content, false, errorMsg);
      console.error('[Notification] DingTalk error:', errorMsg);
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
      console.log('[Notification] Feishu notification sent');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'feishu', title, content, false, errorMsg);
      console.error('[Notification] Feishu error:', errorMsg);
    }
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
      console.error('[Notification] Failed to log notification:', e);
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
}

export const notificationService = new NotificationService();
