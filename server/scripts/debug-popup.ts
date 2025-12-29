/**
 * 调试脚本：检查淘宝商品页面的"知道了"弹窗DOM结构
 */
import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. 获取账号cookies
  const account = await prisma.taobaoAccount.findFirst({
    where: { isActive: true },
    select: { cookies: true }
  });
  
  if (!account?.cookies) {
    console.log('No active account found');
    return;
  }
  
  const cookies = JSON.parse(Buffer.from(account.cookies, 'base64').toString('utf-8'));
  console.log('Loaded', cookies.length, 'cookies');
  
  // 2. 启动浏览器
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });
  
  // 3. 注入cookies
  await context.addCookies(cookies);
  console.log('Cookies injected');
  
  // 4. 打开商品页面
  const page = await context.newPage();
  const productId = '613759001227';
  const url = `https://item.taobao.com/item.htm?id=${productId}`;
  console.log('Navigating to:', url);
  
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  // 5. 截图保存当前状态
  await page.screenshot({ path: 'debug-page-initial.png', fullPage: false });
  console.log('Screenshot saved: debug-page-initial.png');
  
  // 6. 检查页面上是否有"知道了"相关元素
  console.log('\n=== Searching for "知道了" elements ===');
  
  const zhidaoElements = await page.evaluate(() => {
    const results: any[] = [];
    const allElements = document.querySelectorAll('*');
    
    for (const el of allElements) {
      const text = el.textContent?.trim() || '';
      if (text === '知道了' || text.includes('知道了')) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        
        // 只记录叶子节点或短文本节点
        if (text.length < 50) {
          results.push({
            tagName: el.tagName,
            className: el.className,
            id: el.id,
            text: text.slice(0, 50),
            visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            display: style.display,
            visibility: style.visibility,
            zIndex: style.zIndex,
            outerHTML: el.outerHTML.slice(0, 200),
          });
        }
      }
    }
    
    return results;
  });
  
  console.log('Found', zhidaoElements.length, '"知道了" elements:');
  zhidaoElements.forEach((el, i) => {
    console.log(`\n[${i}] <${el.tagName}> class="${el.className}" id="${el.id}"`);
    console.log(`    text: "${el.text}"`);
    console.log(`    visible: ${el.visible}, display: ${el.display}, visibility: ${el.visibility}, zIndex: ${el.zIndex}`);
    console.log(`    rect: x=${el.rect.x}, y=${el.rect.y}, w=${el.rect.width}, h=${el.rect.height}`);
    console.log(`    outerHTML: ${el.outerHTML}`);
  });
  
  // 7. 检查"新增大图查看功能"弹窗
  console.log('\n=== Searching for "新增大图查看功能" popup ===');
  
  const tipPopup = await page.evaluate(() => {
    const results: any[] = [];
    const allElements = document.querySelectorAll('*');
    
    for (const el of allElements) {
      const text = el.textContent?.trim() || '';
      if (text.includes('新增大图') || text.includes('大图查看') || text.includes('切换大图模式')) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        
        results.push({
          tagName: el.tagName,
          className: el.className,
          id: el.id,
          text: text.slice(0, 100),
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          backgroundColor: style.backgroundColor,
          outerHTML: el.outerHTML.slice(0, 300),
        });
      }
    }
    
    return results;
  });
  
  console.log('Found', tipPopup.length, '"大图查看" elements:');
  tipPopup.forEach((el, i) => {
    console.log(`\n[${i}] <${el.tagName}> class="${el.className}"`);
    console.log(`    text: "${el.text}"`);
    console.log(`    visible: ${el.visible}, bgColor: ${el.backgroundColor}`);
    console.log(`    rect: x=${el.rect.x}, y=${el.rect.y}, w=${el.rect.width}, h=${el.rect.height}`);
    console.log(`    outerHTML: ${el.outerHTML}`);
  });
  
  // 8. 检查遮罩层
  console.log('\n=== Searching for mask/overlay elements ===');
  
  const masks = await page.evaluate(() => {
    const results: any[] = [];
    const selectors = [
      '[class*="mask"]',
      '[class*="Mask"]',
      '[class*="overlay"]',
      '[class*="Overlay"]',
      '[class*="modal"]',
      '[class*="Modal"]',
      '[class*="dialog"]',
      '[class*="Dialog"]',
      '[class*="popup"]',
      '[class*="Popup"]',
      '[class*="tip"]',
      '[class*="guide"]',
      '[class*="Guide"]',
    ];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        
        if (visible) {
          results.push({
            selector,
            tagName: el.tagName,
            className: el.className,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            zIndex: style.zIndex,
            backgroundColor: style.backgroundColor,
          });
        }
      }
    }
    
    return results;
  });
  
  console.log('Found', masks.length, 'visible mask/overlay elements:');
  masks.forEach((el, i) => {
    console.log(`[${i}] ${el.selector} <${el.tagName}> class="${el.className.slice(0, 80)}"`);
    console.log(`    rect: ${el.rect.x},${el.rect.y} ${el.rect.width}x${el.rect.height}, zIndex: ${el.zIndex}, bg: ${el.backgroundColor}`);
  });
  
  // 保持浏览器打开以便手动检查
  console.log('\n=== Browser will stay open for manual inspection ===');
  console.log('Press Ctrl+C to close');
  
  // 等待用户手动关闭
  await new Promise(() => {});
}

main().catch(console.error);
