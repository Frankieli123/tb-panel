import { chromium } from 'playwright';

(async () => {
  console.log('🔍 开始深度分析淘宝商品页面结构...\n');

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome'
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    console.log('📍 导航到淘宝商品页面...');
    await page.goto('https://item.taobao.com/item.htm?id=763610208097', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    console.log('⏳ 等待10秒让页面完全渲染和JS执行...');
    await page.waitForTimeout(10000);

    // 先截图看看页面是什么样的
    await page.screenshot({ path: 'e:\\APP\\taobao\\taobao-page-step1.png', fullPage: true });
    console.log('📸 第一张截图已保存\n');

    // 获取页面的全部HTML结构
    const htmlStructure = await page.evaluate(() => {
      // 1. 检查所有全局变量
      const win = window as any;
      const allGlobalVars = Object.keys(win).filter(key =>
        key.toLowerCase().includes('sku') ||
        key.toLowerCase().includes('cart') ||
        key.toLowerCase().includes('config') ||
        key.toLowerCase().includes('data') ||
        key.toLowerCase().includes('initial')
      );

      // 2. 获取body的class和id
      const bodyInfo = {
        classList: Array.from(document.body.classList),
        id: document.body.id
      };

      // 3. 查找所有包含"颜色"、"尺码"、"规格"的元素
      const allElements = Array.from(document.querySelectorAll('*'));
      const specElements = allElements.filter(el => {
        const text = el.textContent || '';
        return text.includes('颜色') || text.includes('尺码') || text.includes('规格') ||
               text.includes('选择') || text.includes('属性');
      }).slice(0, 10).map(el => ({
        tagName: el.tagName,
        classList: Array.from(el.classList),
        id: el.id,
        textContent: el.textContent?.substring(0, 100)
      }));

      // 4. 查找所有按钮和链接
      const allButtons = Array.from(document.querySelectorAll('button, a, div[role="button"]')).slice(0, 30).map(el => ({
        tagName: el.tagName,
        classList: Array.from(el.classList),
        id: el.id,
        textContent: el.textContent?.trim().substring(0, 50),
        role: el.getAttribute('role'),
        onClick: !!el.getAttribute('onclick')
      }));

      // 5. 查找所有包含价格符号的元素
      const priceElements = allElements.filter(el => {
        const text = el.textContent || '';
        return text.includes('¥') || text.includes('元') || text.includes('价格');
      }).slice(0, 10).map(el => ({
        tagName: el.tagName,
        classList: Array.from(el.classList),
        id: el.id,
        textContent: el.textContent?.trim().substring(0, 100)
      }));

      // 6. 查找所有div、section、article标签的前50个（可能的容器）
      const containers = Array.from(document.querySelectorAll('div, section, article')).slice(0, 50).map(el => ({
        tagName: el.tagName,
        classList: Array.from(el.classList),
        id: el.id,
        childrenCount: el.children.length
      }));

      // 7. 获取页面标题
      const pageTitle = document.title;

      // 8. 检查是否有登录相关元素
      const loginElements = allElements.filter(el => {
        const text = el.textContent || '';
        return text.includes('登录') || text.includes('扫码') || text.includes('验证');
      }).slice(0, 5).map(el => ({
        tagName: el.tagName,
        textContent: el.textContent?.trim().substring(0, 100)
      }));

      return {
        allGlobalVars,
        bodyInfo,
        specElements,
        allButtons,
        priceElements,
        containers,
        pageTitle,
        loginElements,
        documentHTML: document.body.innerHTML.substring(0, 2000)
      };
    });

    console.log('📊 页面结构分析结果：\n');
    console.log('='.repeat(100));

    console.log('\n🌐 页面标题:', htmlStructure.pageTitle);

    console.log('\n🔐 登录相关元素:');
    console.log(JSON.stringify(htmlStructure.loginElements, null, 2));

    console.log('\n📦 Body信息:');
    console.log(JSON.stringify(htmlStructure.bodyInfo, null, 2));

    console.log('\n🌍 全局变量列表 (前20个):');
    console.log(htmlStructure.allGlobalVars.slice(0, 20));

    console.log('\n🏷️  规格/属性相关元素:');
    console.log(JSON.stringify(htmlStructure.specElements, null, 2));

    console.log('\n🔘 所有按钮/链接 (前20个):');
    console.log(JSON.stringify(htmlStructure.allButtons.slice(0, 20), null, 2));

    console.log('\n💰 价格相关元素:');
    console.log(JSON.stringify(htmlStructure.priceElements, null, 2));

    console.log('\n📦 主要容器 (前10个):');
    console.log(JSON.stringify(htmlStructure.containers.slice(0, 10), null, 2));

    console.log('\n📄 Body HTML (前2000字符):');
    console.log(htmlStructure.documentHTML);

    console.log('\n' + '='.repeat(100));

    // 最终截图
    await page.screenshot({ path: 'e:\\APP\\taobao\\taobao-page-final.png', fullPage: true });
    console.log('\n📸 最终截图已保存到: e:\\APP\\taobao\\taobao-page-final.png');

    console.log('\n⏸️  浏览器将保持打开30秒，请手动检查页面...');
    await page.waitForTimeout(30000);

  } catch (error: any) {
    console.error('❌ 分析失败:', error.message);
  } finally {
    await browser.close();
    console.log('\n✅ 分析完成');
  }
})();
