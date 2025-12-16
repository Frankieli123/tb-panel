import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { PrismaClient, Product, NotificationConfig } from '@prisma/client';
import { formatPrice } from '../utils/helpers.js';

const prisma = new PrismaClient();

interface PriceDropNotification {
  product: Product;
  oldPrice: number;
  newPrice: number;
  drop: { amount: number; percent: number };
  config: NotificationConfig;
}

class NotificationService {
  private emailTransporter: nodemailer.Transporter | null = null;

  constructor() {
    this.initEmailTransporter();
  }

  private initEmailTransporter(): void {
    if (config.smtp.user && config.smtp.pass) {
      this.emailTransporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: {
          user: config.smtp.user,
          pass: config.smtp.pass,
        },
      });
    }
  }

  async sendPriceDropNotification(data: PriceDropNotification): Promise<void> {
    const { product, oldPrice, newPrice, drop, config: notifyConfig } = data;

    const title = `【降价提醒】${product.title || '商品'}`;
    const content = this.buildNotificationContent(product, oldPrice, newPrice, drop);

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

    // Telegram通知
    if (notifyConfig.telegramEnabled && notifyConfig.telegramBotToken && notifyConfig.telegramChatId) {
      promises.push(
        this.sendTelegram(
          notifyConfig.telegramBotToken,
          notifyConfig.telegramChatId,
          title,
          content,
          product.id
        )
      );
    }

    await Promise.allSettled(promises);
  }

  private buildNotificationContent(
    product: Product,
    oldPrice: number,
    newPrice: number,
    drop: { amount: number; percent: number }
  ): string {
    return `
商品：${product.title || product.taobaoId}
原价：${formatPrice(oldPrice)}
现价：${formatPrice(newPrice)}
降幅：${formatPrice(drop.amount)} (${drop.percent.toFixed(1)}%)
链接：${product.url}
    `.trim();
  }

  private async sendEmail(
    to: string,
    subject: string,
    text: string,
    productId: string
  ): Promise<void> {
    if (!this.emailTransporter) {
      console.warn('[Notification] Email transporter not configured');
      return;
    }

    try {
      await this.emailTransporter.sendMail({
        from: config.smtp.from,
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

  private async sendTelegram(
    botToken: string,
    chatId: string,
    title: string,
    content: string,
    productId: string
  ): Promise<void> {
    try {
      const message = `*${title}*\n\n${content}`;
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await this.logNotification(productId, 'telegram', title, content, true);
      console.log('[Notification] Telegram notification sent');

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logNotification(productId, 'telegram', title, content, false, errorMsg);
      console.error('[Notification] Telegram error:', errorMsg);
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
    channel: 'email' | 'wechat' | 'telegram',
    config: Partial<NotificationConfig>
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

        case 'telegram':
          if (!config.telegramBotToken || !config.telegramChatId) {
            throw new Error('Bot token and chat ID required');
          }
          await this.sendTelegram(
            config.telegramBotToken,
            config.telegramChatId,
            testTitle,
            testContent,
            testProductId
          );
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
}

export const notificationService = new NotificationService();
