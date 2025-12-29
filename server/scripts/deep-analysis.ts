import { PrismaClient } from '@prisma/client';
import { TaobaoScraper } from '../src/services/scraper.js';

const prisma = new PrismaClient();

async function deepAnalysis() {
  console.log('🔍 深度分析天猫商品页面...\n');

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

    console.log('⏳ 等待8秒让JavaScript完全执行...');
    await page.waitForTimeout(8000);

    // 提取全局数据和完整DOM结构
    const deepData = await page.evaluate(() => {
      const win = window as any;

      // 1. 提取所有可能的全局SKU数据源
      const globalDataSources = {
        g_config: {
          exists: !!win.g_config,
          keys: win.g_config ? Object.keys(win.g_config).slice(0, 30) : [],
          itemData: win.g_config?.itemData,
          skuData: win.g_config?.skuData,
          sku: win.g_config?.sku
        },
        __INITIAL_STATE__: {
          exists: !!win.__INITIAL_STATE__,
          keys: win.__INITIAL_STATE__ ? Object.keys(win.__INITIAL_STATE__).slice(0, 30) : []
        },
        runParams: {
          exists: !!win.runParams,
          data: win.runParams
        }
      };

      // 2. 查找SKU面板及其所有子元素
      const skuPanel = document.querySelector('[id*="SkuPanel"]');
      const skuPanelDetails = skuPanel ? {
        found: true,
        id: skuPanel.id,
        classList: Array.from(skuPanel.classList),
        // 查找所有 data-vid 元素
        skuOptions: Array.from(skuPanel.querySelectorAll('[data-vid]')).map((el: any) => ({
          vid: el.getAttribute('data-vid'),
          disabled: el.getAttribute('data-disabled'),
          classList: Array.from(el.classList),
          text: el.textContent?.trim().substring(0, 100),
          hasImage: !!el.querySelector('img'),
          imageUrl: el.querySelector('img')?.src
        }))
      } : { found: false };

      // 3. 查找所有可能的购买/加购按钮
      const allButtons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const purchaseButtons = allButtons.map((btn: any) => ({
        tagName: btn.tagName,
        id: btn.id,
        classList: Array.from(btn.classList),
        text: btn.textContent?.trim().substring(0, 50),
        dataAction: btn.getAttribute('data-action'),
        dataType: btn.getAttribute('data-type'),
        role: btn.getAttribute('role'),
        outerHTML: btn.outerHTML.substring(0, 300)
      })).filter(btn =>
        btn.text?.includes('加购') ||
        btn.text?.includes('购物车') ||
        btn.text?.includes('立即购买') ||
        btn.text?.includes('买') ||
        btn.classList.some((c: string) =>
          c.toLowerCase().includes('cart') ||
          c.toLowerCase().includes('buy') ||
          c.toLowerCase().includes('purchase')
        )
      );

      // 4. 查找价格区域
      const priceArea = document.querySelector('[class*="Price"]');
      const priceDetails = priceArea ? {
        found: true,
        innerHTML: priceArea.innerHTML.substring(0, 1000),
        // 提取实际价格数字
        priceNumbers: Array.from(priceArea.querySelectorAll('[class*="text"]')).map((el: any) => ({
          classList: Array.from(el.classList),
          text: el.textContent?.trim()
        }))
      } : { found: false };

      // 5. 检查是否有 React/Vue 组件数据
      const reactRoot = document.querySelector('[data-reactroot], [id*="root"]');
      const vueApp = document.querySelector('[id*="app"]');

      // 6. 查找所有包含 "规格" 的元素
      const specElements = Array.from(document.querySelectorAll('*')).filter((el: any) => {
        const text = el.textContent || '';
        return text.includes('规格') || text.includes('选择');
      }).slice(0, 10).map((el: any) => ({
        tagName: el.tagName,
        classList: Array.from(el.classList),
        textContent: el.textContent?.substring(0, 100)
      }));

      return {
        globalDataSources,
        skuPanelDetails,
        purchaseButtons,
        priceDetails,
        hasReact: !!reactRoot,
        hasVue: !!vueApp,
        specElements,
        documentTitle: document.title
      };
    });

    console.log('📊 深度分析结果：\n');
    console.log('='.repeat(100));

    console.log('\n🌍 全局数据源:');
    console.log(JSON.stringify(deepData.globalDataSources, null, 2));

    console.log('\n📦 SKU面板详情:');
    console.log(JSON.stringify(deepData.skuPanelDetails, null, 2));

    console.log('\n🛒 购买相关按钮:');
    console.log(JSON.stringify(deepData.purchaseButtons, null, 2));

    console.log('\n💰 价格区域详情:');
    console.log(JSON.stringify(deepData.priceDetails, null, 2));

    console.log('\n🏷️  规格相关元素:');
    console.log(JSON.stringify(deepData.specElements, null, 2));

    console.log('\n⚙️  框架检测:');
    console.log('Has React:', deepData.hasReact);
    console.log('Has Vue:', deepData.hasVue);

    console.log('\n' + '='.repeat(100));

    // 现在让我们尝试提取完整的 window.g_config
    const gConfigData = await page.evaluate(() => {
      const win = window as any;
      return JSON.stringify(win.g_config, null, 2);
    });

    console.log('\n📄 完整 window.g_config:');
    console.log(gConfigData.substring(0, 5000)); // 前5000字符

    await page.screenshot({
      path: 'e:\\APP\\taobao\\tmall-deep-analysis.png',
      fullPage: true
    });
    console.log('\n📸 截图已保存: tmall-deep-analysis.png');

    console.log('\n⏸️  浏览器将保持打开20秒...');
    await page.waitForTimeout(20000);

    await page.close();
    await scraper.close();

  } catch (error: any) {
    console.error('❌ 分析失败:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

deepAnalysis();
