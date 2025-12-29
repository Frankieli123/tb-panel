import { PrismaClient } from '@prisma/client';
import { TaobaoScraper } from '../src/services/scraper.js';
import fs from 'fs/promises';

const prisma = new PrismaClient();

async function analyzeCartPage() {
  console.log('🔍 分析购物车页面真实DOM结构...\n');

  try {
    const account = await prisma.taobaoAccount.findFirst({
      where: { isActive: true }
    });

    if (!account) {
      console.error('❌ 没有找到活跃的淘宝账号');
      return;
    }

    console.log(`✅ 使用账号: ${account.name} (ID: ${account.id})\n`);

    const scraper = new TaobaoScraper();
    await scraper.init({ headless: false });

    const context = await scraper.getContext(account.id, account.cookies);
    const page = await context.newPage();

    const cartUrl = 'https://cart.taobao.com/cart.htm';
    console.log(`📍 访问购物车: ${cartUrl}\n`);

    await page.goto(cartUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('⏳ 等待15秒让购物车完全加载...');
    await page.waitForTimeout(15000);

    console.log('\n' + '='.repeat(80));
    console.log('📊 分析结果：');
    console.log('='.repeat(80) + '\n');

    // 1. 检查全局变量
    const globalVars = await page.evaluate(() => {
      const win = window as any;
      return {
        hasCartInitialData: !!win.__CART_INITIAL_DATA__,
        hasCartData: !!win.cartData,
        hasTbCartData: !!win.TB?.cart,
        hasGConfig: !!win.g_config,

        // 尝试获取实际数据结构
        cartInitialDataKeys: win.__CART_INITIAL_DATA__ ? Object.keys(win.__CART_INITIAL_DATA__) : [],
        cartDataKeys: win.cartData ? Object.keys(win.cartData) : [],

        // 尝试获取购物车商品数量
        cartItemCount: win.__CART_INITIAL_DATA__?.items?.length ??
                       win.cartData?.items?.length ??
                       'unknown',

        // 完整的数据结构示例（前3个商品）
        sampleData: win.__CART_INITIAL_DATA__?.items?.slice(0, 3) ??
                    win.cartData?.items?.slice(0, 3) ??
                    null
      };
    });

    console.log('1️⃣ 全局变量检查：\n');
    console.log(JSON.stringify(globalVars, null, 2));
    console.log('\n' + '-'.repeat(80) + '\n');

    // 2. 分析DOM结构 - 购物车商品列表
    const domStructure = await page.evaluate(() => {
      // 查找可能的购物车商品容器
      const possibleContainers = [
        document.querySelector('[class*="cart-item"]'),
        document.querySelector('[class*="cartItem"]'),
        document.querySelector('[class*="item-container"]'),
        document.querySelector('[data-spm*="cart"]'),
        document.querySelector('[id*="cart"]')
      ].filter(Boolean);

      if (possibleContainers.length === 0) {
        return { error: '未找到购物车商品容器' };
      }

      const firstItem = possibleContainers[0];

      return {
        containerSelector: firstItem!.className,
        containerId: firstItem!.id,

        // 查找商品标题
        titleSelectors: [
          firstItem!.querySelector('[class*="title"]')?.className,
          firstItem!.querySelector('[class*="name"]')?.className,
          firstItem!.querySelector('a[title]')?.className
        ].filter(Boolean),

        // 查找价格
        priceSelectors: [
          firstItem!.querySelector('[class*="price"]')?.className,
          firstItem!.querySelector('[class*="Price"]')?.className,
          firstItem!.querySelector('[data-price]')?.className
        ].filter(Boolean),

        // 查找SKU信息
        skuSelectors: [
          firstItem!.querySelector('[class*="sku"]')?.className,
          firstItem!.querySelector('[class*="SKU"]')?.className,
          firstItem!.querySelector('[class*="spec"]')?.className,
          firstItem!.querySelector('[class*="attr"]')?.className
        ].filter(Boolean),

        // 查找图片
        imageSelectors: [
          firstItem!.querySelector('img')?.className,
          firstItem!.querySelector('[class*="pic"]')?.className,
          firstItem!.querySelector('[class*="image"]')?.className
        ].filter(Boolean),

        // 完整的HTML结构（前500字符）
        sampleHTML: firstItem!.outerHTML.substring(0, 1000)
      };
    });

    console.log('2️⃣ DOM结构分析：\n');
    console.log(JSON.stringify(domStructure, null, 2));
    console.log('\n' + '-'.repeat(80) + '\n');

    // 3. 提取实际购物车数据（前5个商品）
    const actualCartData = await page.evaluate(() => {
      const items: any[] = [];

      // 尝试多种选择器
      const selectors = [
        '[class*="cart-item"]',
        '[class*="cartItem"]',
        '[class*="item-container"]',
        '[data-spm*="cart"]'
      ];

      let cartItems: Element[] = [];
      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        if (elements.length > 0) {
          cartItems = elements;
          break;
        }
      }

      cartItems.slice(0, 5).forEach((item, idx) => {
        // 标题
        const titleEl = item.querySelector('[class*="title"], a[title], [class*="name"]');
        const title = titleEl?.textContent?.trim() || titleEl?.getAttribute('title');

        // 价格
        const priceEl = item.querySelector('[class*="price"], [class*="Price"]');
        const priceText = priceEl?.textContent?.trim();

        // SKU属性
        const skuEl = item.querySelector('[class*="sku"], [class*="spec"], [class*="attr"]');
        const skuText = skuEl?.textContent?.trim();

        // 图片
        const imgEl = item.querySelector('img');
        const imageUrl = imgEl?.src;

        // data属性
        const dataId = item.getAttribute('data-id') || item.getAttribute('data-item-id');
        const dataSku = item.getAttribute('data-sku') || item.getAttribute('data-sku-id');

        items.push({
          index: idx,
          title,
          priceText,
          skuText,
          imageUrl: imageUrl?.substring(0, 100),
          dataId,
          dataSku,
          classList: Array.from(item.classList)
        });
      });

      return items;
    });

    console.log('3️⃣ 实际购物车数据（前5个商品）：\n');
    console.log(JSON.stringify(actualCartData, null, 2));
    console.log('\n' + '-'.repeat(80) + '\n');

    // 4. 查找商品ID和SKU ID的位置
    const idAnalysis = await page.evaluate(() => {
      const items = document.querySelectorAll('[class*="cart-item"], [class*="cartItem"]');
      if (items.length === 0) return { error: '未找到商品' };

      const firstItem = items[0];

      // 查找所有可能包含ID的属性
      const attributes = Array.from(firstItem.attributes).map(attr => ({
        name: attr.name,
        value: attr.value.substring(0, 100)
      }));

      // 查找链接中的ID
      const links = Array.from(firstItem.querySelectorAll('a[href*="id="]'));
      const linkIds = links.map((link: any) => {
        const href = link.href;
        const match = href.match(/[?&]id=(\d+)/);
        return match ? match[1] : null;
      }).filter(Boolean);

      // 查找data-*属性
      const dataAttrs: any = {};
      Array.from(firstItem.attributes).forEach((attr: any) => {
        if (attr.name.startsWith('data-')) {
          dataAttrs[attr.name] = attr.value;
        }
      });

      return {
        attributes,
        linkIds,
        dataAttributes: dataAttrs
      };
    });

    console.log('4️⃣ 商品ID/SKU ID定位分析：\n');
    console.log(JSON.stringify(idAnalysis, null, 2));
    console.log('\n' + '='.repeat(80) + '\n');

    // 5. 截图
    const screenshotPath = 'e:\\APP\\taobao\\cart-page-analysis.png';
    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    });
    console.log(`📸 已保存购物车页面截图: ${screenshotPath}\n`);

    // 6. 保存完整HTML
    const html = await page.content();
    const htmlPath = 'e:\\APP\\taobao\\cart-page.html';
    await fs.writeFile(htmlPath, html, 'utf-8');
    console.log(`📄 已保存完整HTML: ${htmlPath}\n`);

    console.log('⏳ 浏览器窗口将保持打开20秒，请手动检查...');
    await page.waitForTimeout(20000);

    await page.close();
    await scraper.close();

    console.log('\n✅ 分析完成！');

  } catch (error: any) {
    console.error('\n❌ 分析失败:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeCartPage();
