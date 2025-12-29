import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();

  let context;
  if (contexts.length > 0) {
    context = contexts[0];
  } else {
    context = await browser.newContext();
  }

  const page = await context.newPage();

  console.log('Opening cart page...');
  await page.goto('https://cart.taobao.com/cart.htm', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(5000);

  // 截图
  await page.screenshot({ path: './debug_cart_full.png', fullPage: true });
  console.log('Screenshot saved to debug_cart_full.png');

  // 获取页面 HTML 结构
  const html = await page.content();
  fs.writeFileSync('./debug_cart.html', html);
  console.log('HTML saved to debug_cart.html');

  // 尝试找到购物车商品元素
  const cartItemSelectors = [
    '.item-content',
    '.J_TbCartItem',
    '[class*="cartItem"]',
    '[class*="item-info"]',
    '.trade-cart-item-info'
  ];

  for (const selector of cartItemSelectors) {
    const count = await page.locator(selector).count();
    console.log(`Selector "${selector}": ${count} items found`);
  }

  // 提取第一个商品的详细信息
  const firstItemData = await page.evaluate(() => {
    const selectors = {
      container: ['.item-content', '.J_TbCartItem', '[class*="cartItem"]', '.trade-cart-item-info'],
      title: ['[class*="title"]', '.item-title', 'a.item-title', 'h3'],
      price: ['[class*="price"]', '.price', '[class*="cartPrice"]'],
      image: ['img', '[class*="image"] img'],
      link: ['a[href*="item.taobao.com"]', 'a[href*="detail.tmall.com"]']
    };

    let containerEl = null;
    for (const sel of selectors.container) {
      containerEl = document.querySelector(sel);
      if (containerEl) {
        console.log(`Found container with: ${sel}`);
        break;
      }
    }

    if (!containerEl) return { error: 'No container found' };

    const result = {
      containerClass: containerEl.className,
      containerHTML: containerEl.innerHTML.substring(0, 500)
    };

    // 查找子元素
    for (const [key, selectorList] of Object.entries(selectors)) {
      if (key === 'container') continue;

      for (const sel of selectorList) {
        const el = containerEl.querySelector(sel);
        if (el) {
          result[key] = {
            selector: sel,
            text: el.textContent?.trim().substring(0, 100),
            className: el.className,
            tagName: el.tagName,
            ...(key === 'image' && { src: el.getAttribute('src') }),
            ...(key === 'link' && { href: el.getAttribute('href') })
          };
          break;
        }
      }
    }

    return result;
  });

  console.log('\nFirst item data:');
  console.log(JSON.stringify(firstItemData, null, 2));

  await page.close();
  await browser.close();
})();
