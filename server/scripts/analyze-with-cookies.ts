import { PrismaClient } from '@prisma/client';
import { TaobaoScraper } from '../src/services/scraper.js';

const prisma = new PrismaClient();

async function analyzeWithRealCookies() {
  console.log('🔍 使用真实Cookie分析淘宝商品页面结构...\n');

  try {
    // 1. 获取账号信息
    const account = await prisma.taobaoAccount.findFirst({
      where: { isActive: true }
    });

    if (!account) {
      console.error('❌ 没有找到活跃的淘宝账号');
      return;
    }

    console.log(`✅ 使用账号: ${account.name} (ID: ${account.id})\n`);

    // 2. 初始化Scraper
    const scraper = new TaobaoScraper();
    await scraper.init();

    // 3. 获取带Cookie的Context
    const context = await scraper.getContext(account.id, account.cookies);
    const page = await context.newPage();

    // 4. 访问商品页面（用户提供的真实天猫链接）
    const testUrl = 'https://detail.tmall.com/item.htm?abbucket=17&id=875765952236&mi_id=00006AP97VWiJEBv7NE75qgXI81jxt4SfNpfTc159NTCTK4&ns=1&priceTId=214780e717666668656797586e190f&skuId=5880572559459&spm=a21n57.1.hoverItem.9&utparam=%7B%22aplus_abtest%22%3A%225dcdd49ae1ab85630efad043482368aa%22%7D&xxc=taobaoSearch';
    console.log(`📍 访问: ${testUrl}`);

    await page.goto(testUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('⏳ 等待5秒让页面渲染...');
    await page.waitForTimeout(5000);

    // 5. 分析页面结构
    const analysis = await page.evaluate(() => {
      const win = window as any;

      // 检查全局SKU数据
      const globalSkuData = {
        hasGConfig: !!win.g_config,
        hasSkuData: !!win.g_config?.skuData,
        hasSkuBase: !!win.g_config?.sku,
        hasInitialState: !!win.__INITIAL_STATE__,
        hasTB: !!win.TB,
        skuDataKeys: win.g_config?.skuData ? Object.keys(win.g_config.skuData).slice(0, 20) : [],
        skuBaseKeys: win.g_config?.sku ? Object.keys(win.g_config.sku).slice(0, 20) : []
      };

      // 查找SKU选择面板
      const skuPanelSelectors = [
        '[class*="SkuPanel"]',
        '[class*="sku-panel"]',
        '[class*="Property"]',
        '[class*="property"]',
        '.J_TSaleProp'
      ];

      const skuPanelResults: any[] = [];
      for (const selector of skuPanelSelectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > 0) {
          skuPanelResults.push({
            selector,
            count: els.length,
            firstElement: {
              tagName: els[0].tagName,
              classList: Array.from(els[0].classList),
              id: els[0].id,
              innerHTML: els[0].innerHTML.substring(0, 500)
            }
          });
        }
      }

      // 查找SKU选项按钮
      const skuOptionSelectors = [
        '[data-spm-anchor-id]',
        '[data-value]',
        '[data-vid]',
        '[class*="SkuItem"]',
        '[class*="sku-item"]',
        'li[data-value]',
        'span[data-value]'
      ];

      const skuOptionResults: any[] = [];
      for (const selector of skuOptionSelectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > 0) {
          const firstEl = els[0];
          skuOptionResults.push({
            selector,
            count: els.length,
            sample: {
              tagName: firstEl.tagName,
              classList: Array.from(firstEl.classList),
              id: firstEl.id,
              dataAttributes: Array.from(firstEl.attributes)
                .filter(attr => attr.name.startsWith('data-'))
                .map(attr => ({ name: attr.name, value: attr.value })),
              textContent: firstEl.textContent?.trim().substring(0, 50),
              innerHTML: firstEl.innerHTML.substring(0, 200)
            }
          });
        }
      }

      // 查找加购按钮
      const addCartButtonSelectors = [
        'button[class*="AddCart"]',
        'button[class*="addCart"]',
        'button[class*="add-cart"]',
        '.J_LinkAdd',
        '[data-action*="cart"]',
        'button:has-text("加入购物车")',
        'a:has-text("加入购物车")'
      ];

      const addCartResults: any[] = [];
      for (const selector of addCartButtonSelectors) {
        try {
          const els = document.querySelectorAll(selector);
          if (els.length > 0) {
            addCartResults.push({
              selector,
              count: els.length,
              sample: {
                tagName: els[0].tagName,
                classList: Array.from(els[0].classList),
                textContent: els[0].textContent?.trim(),
                outerHTML: els[0].outerHTML.substring(0, 300)
              }
            });
          }
        } catch (e) {}
      }

      // 通过文本查找加购按钮
      const allButtons = Array.from(document.querySelectorAll('button, a'));
      const cartButtonsByText = allButtons
        .filter(el => {
          const text = el.textContent?.trim() || '';
          return text.includes('加入购物车') || text.includes('加购') || text === '加购';
        })
        .slice(0, 5)
        .map(el => ({
          tagName: el.tagName,
          classList: Array.from(el.classList),
          id: el.id,
          textContent: el.textContent?.trim(),
          outerHTML: el.outerHTML.substring(0, 400)
        }));

      // 查找价格元素
      const priceSelectors = [
        '[class*="Price"]',
        '[class*="price"]',
        '.tb-rmb',
        '.promo-price',
        '[class*="promo"]'
      ];

      const priceResults: any[] = [];
      for (const selector of priceSelectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > 0) {
          priceResults.push({
            selector,
            count: els.length,
            sample: {
              tagName: els[0].tagName,
              classList: Array.from(els[0].classList),
              textContent: els[0].textContent?.trim(),
              innerHTML: els[0].innerHTML.substring(0, 200)
            }
          });
        }
      }

      return {
        pageTitle: document.title,
        globalSkuData,
        skuPanelResults,
        skuOptionResults,
        addCartResults,
        cartButtonsByText,
        priceResults
      };
    });

    console.log('\n📊 淘宝商品页面结构分析结果：\n');
    console.log('='.repeat(100));

    console.log('\n🌐 页面标题:', analysis.pageTitle);

    console.log('\n🌍 全局SKU数据检查:');
    console.log(JSON.stringify(analysis.globalSkuData, null, 2));

    console.log('\n📦 SKU选择面板:');
    console.log(JSON.stringify(analysis.skuPanelResults, null, 2));

    console.log('\n🏷️  SKU选项按钮:');
    console.log(JSON.stringify(analysis.skuOptionResults, null, 2));

    console.log('\n🛒 加购按钮 (选择器查找):');
    console.log(JSON.stringify(analysis.addCartResults, null, 2));

    console.log('\n🛒 加购按钮 (文本查找):');
    console.log(JSON.stringify(analysis.cartButtonsByText, null, 2));

    console.log('\n💰 价格元素:');
    console.log(JSON.stringify(analysis.priceResults, null, 2));

    console.log('\n='.repeat(100));

    // 截图
    await page.screenshot({
      path: 'e:\\APP\\taobao\\taobao-page-with-cookies.png',
      fullPage: true
    });
    console.log('\n📸 截图已保存: taobao-page-with-cookies.png');

    console.log('\n⏸️  浏览器将保持打开30秒，请手动检查页面...');
    await page.waitForTimeout(30000);

    await page.close();
    await scraper.close();

  } catch (error: any) {
    console.error('❌ 分析失败:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeWithRealCookies();