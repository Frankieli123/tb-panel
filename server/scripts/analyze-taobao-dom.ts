import { chromium } from 'playwright';

(async () => {
  console.log('🔍 开始分析淘宝商品页面结构...\n');

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome'
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });

  const page = await context.newPage();

  try {
    // 访问一个真实的淘宝商品页面
    await page.goto('https://item.taobao.com/item.htm?id=763610208097', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('✅ 页面加载完成，等待3秒让JavaScript渲染...\n');
    await page.waitForTimeout(3000);

    // 分析SKU选择器结构
    const skuAnalysis = await page.evaluate(() => {
      const win = window as any;

      // 1. 检查全局变量
      const globalVars = {
        g_config: !!win.g_config,
        g_config_skuData: !!win.g_config?.skuData,
        __INITIAL_STATE__: !!win.__INITIAL_STATE__,
        TB: !!win.TB,
        TB_detail: !!win.TB?.detail
      };

      // 2. 检查SKU面板
      const skuPanelSelectors = [
        '[id*="SkuPanel"]',
        '[class*="sku"]',
        '[class*="Sku"]',
        '.tb-property',
        '.J_Prop'
      ];

      const skuPanels: any[] = [];
      for (const selector of skuPanelSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          skuPanels.push({
            selector,
            found: true,
            classList: Array.from(el.classList),
            id: el.id,
            innerHTML: el.innerHTML.substring(0, 300)
          });
        }
      }

      // 3. 检查SKU选项按钮
      const skuOptionSelectors = [
        '[data-vid]',
        '[data-value]',
        '[data-sku-value]',
        '.tb-sku-item',
        '.J_TSaleProp',
        '[class*="SkuItem"]'
      ];

      const skuOptions: any[] = [];
      for (const selector of skuOptionSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          const firstEl = elements[0];
          skuOptions.push({
            selector,
            count: elements.length,
            firstElement: {
              classList: Array.from(firstEl.classList),
              attributes: Array.from(firstEl.attributes).map(attr => ({ name: attr.name, value: attr.value })),
              innerHTML: firstEl.innerHTML.substring(0, 200)
            }
          });
        }
      }

      // 4. 检查"加入购物车"按钮
      const addCartSelectors = [
        '.addcart-btn',
        '.add-cart-btn',
        'button[class*="AddCart"]',
        'button[class*="addCart"]',
        '.J_LinkAdd',
        '[data-action="addToCart"]'
      ];

      const addCartButtons: any[] = [];
      for (const selector of addCartSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          addCartButtons.push({
            selector,
            found: true,
            classList: Array.from(el.classList),
            id: el.id,
            textContent: el.textContent?.trim(),
            outerHTML: el.outerHTML.substring(0, 300)
          });
        }
      }

      // 5. 查找任何包含"加入购物车"文字的元素
      const allButtons = Array.from(document.querySelectorAll('button, a'));
      const cartButtonsByText = allButtons
        .filter(el => el.textContent?.includes('加入购物车') || el.textContent?.includes('加购'))
        .slice(0, 3)
        .map(el => ({
          tagName: el.tagName,
          classList: Array.from(el.classList),
          id: el.id,
          textContent: el.textContent?.trim(),
          outerHTML: el.outerHTML.substring(0, 300)
        }));

      // 6. 检查价格元素
      const priceSelectors = [
        '.price',
        '.final-price',
        '[class*="Price"]',
        '.tb-rmb-num',
        '.J_PromPrice'
      ];

      const priceElements: any[] = [];
      for (const selector of priceSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          priceElements.push({
            selector,
            classList: Array.from(el.classList),
            textContent: el.textContent?.trim(),
            outerHTML: el.outerHTML.substring(0, 200)
          });
        }
      }

      return {
        globalVars,
        skuPanels,
        skuOptions,
        addCartButtons,
        cartButtonsByText,
        priceElements
      };
    });

    console.log('📊 淘宝页面结构分析结果：\n');
    console.log('='.repeat(80));
    console.log('\n1️⃣  全局变量检查：');
    console.log(JSON.stringify(skuAnalysis.globalVars, null, 2));

    console.log('\n2️⃣  SKU面板检查：');
    console.log(JSON.stringify(skuAnalysis.skuPanels, null, 2));

    console.log('\n3️⃣  SKU选项按钮检查：');
    console.log(JSON.stringify(skuAnalysis.skuOptions, null, 2));

    console.log('\n4️⃣  加入购物车按钮检查：');
    console.log(JSON.stringify(skuAnalysis.addCartButtons, null, 2));

    console.log('\n5️⃣  通过文字找到的购物车按钮：');
    console.log(JSON.stringify(skuAnalysis.cartButtonsByText, null, 2));

    console.log('\n6️⃣  价格元素检查：');
    console.log(JSON.stringify(skuAnalysis.priceElements, null, 2));

    console.log('\n='.repeat(80));

    // 截图保存
    await page.screenshot({ path: 'e:\\APP\\taobao\\taobao-page-analysis.png', fullPage: true });
    console.log('\n📸 页面截图已保存到: e:\\APP\\taobao\\taobao-page-analysis.png');

  } catch (error) {
    console.error('❌ 分析失败:', error);
  } finally {
    await browser.close();
    console.log('\n✅ 分析完成');
  }
})();
