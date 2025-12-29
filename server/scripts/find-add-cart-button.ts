import { PrismaClient } from '@prisma/client';
import { TaobaoScraper } from '../src/services/scraper.js';

const prisma = new PrismaClient();

async function findAddCartButton() {
  console.log('🔍 寻找加入购物车按钮...\n');

  try {
    const account = await prisma.taobaoAccount.findFirst({
      where: { isActive: true }
    });

    if (!account) {
      console.error('❌ 没有找到活跃的淘宝账号');
      return;
    }

    const scraper = new TaobaoScraper();
    await scraper.init();

    const context = await scraper.getContext(account.id, account.cookies);
    const page = await context.newPage();

    const testUrl = 'https://detail.tmall.com/item.htm?id=875765952236';
    console.log(`📍 访问: ${testUrl}\n`);

    await page.goto(testUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('⏳ 等待12秒让所有JavaScript和异步组件加载...');
    await page.waitForTimeout(12000);

    // 寻找所有可能的按钮
    const allButtons = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"], span[role="button"]'));

      return buttons.map(btn => {
        const text = btn.textContent?.trim() || '';
        const hasCartKeyword =
          text.includes('购物车') ||
          text.includes('加购') ||
          text.includes('加入') ||
          text.includes('cart') ||
          text.includes('Cart') ||
          text.includes('立即购买') ||
          text.includes('立即买');

        return {
          tagName: btn.tagName,
          id: btn.id,
          classList: Array.from(btn.classList),
          text: text.substring(0, 100),
          hasCartKeyword,
          dataAction: btn.getAttribute('data-action'),
          dataType: btn.getAttribute('data-type'),
          role: btn.getAttribute('role'),
          outerHTML: btn.outerHTML.substring(0, 500)
        };
      }).filter(btn => btn.hasCartKeyword || btn.classList.some(c =>
        c.toLowerCase().includes('cart') ||
        c.toLowerCase().includes('buy') ||
        c.toLowerCase().includes('purchase') ||
        c.toLowerCase().includes('action')
      ));
    });

    console.log('📊 找到的购买相关按钮：\n');
    console.log(JSON.stringify(allButtons, null, 2));

    // 尝试查找主要操作区域
    const actionArea = await page.evaluate(() => {
      // 查找可能包含操作按钮的区域
      const possibleContainers = [
        document.querySelector('[class*="ActionBar"]'),
        document.querySelector('[class*="actionBar"]'),
        document.querySelector('[class*="PurchaseBar"]'),
        document.querySelector('[class*="BuyBar"]'),
        document.querySelector('[class*="Operation"]'),
        document.querySelector('[id*="Action"]'),
        document.querySelector('[id*="Purchase"]')
      ].filter(Boolean);

      return possibleContainers.map(container => ({
        classList: Array.from(container!.classList),
        id: container!.id,
        innerHTML: container!.innerHTML.substring(0, 2000)
      }));
    });

    console.log('\n📦 可能的操作区域：\n');
    console.log(JSON.stringify(actionArea, null, 2));

    // 截图并标记所有button元素
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, [role="button"]');
      buttons.forEach((btn, idx) => {
        const label = document.createElement('div');
        label.textContent = `BTN${idx}`;
        label.style.cssText = 'position:absolute;background:red;color:white;padding:2px 5px;font-size:12px;z-index:99999;';
        const rect = btn.getBoundingClientRect();
        label.style.top = `${window.scrollY + rect.top}px`;
        label.style.left = `${window.scrollX + rect.left}px`;
        document.body.appendChild(label);
      });
    });

    await page.screenshot({
      path: 'e:\\APP\\taobao\\tmall-buttons-marked.png',
      fullPage: true
    });
    console.log('\n📸 已标记所有按钮的截图: tmall-buttons-marked.png');

    await page.waitForTimeout(15000);

    await page.close();
    await scraper.close();

  } catch (error: any) {
    console.error('❌ 分析失败:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

findAddCartButton();
