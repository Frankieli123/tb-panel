#!/usr/bin/env node
/**
 * 账号登录脚本
 * 使用方法: npx tsx src/scripts/login.ts --account=<accountId>
 */

import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { encryptCookies } from '../utils/helpers.js';
import readline from 'readline';

const prisma = new PrismaClient();

// 解析命令行参数
const args = process.argv.slice(2);
const accountId = args.find(a => a.startsWith('--account='))?.split('=')[1];

if (!accountId) {
  console.error('Usage: npx tsx src/scripts/login.ts --account=<accountId>');
  process.exit(1);
}

async function main() {
  // 查找账号
  const account = await prisma.taobaoAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    console.error(`Account not found: ${accountId}`);
    process.exit(1);
  }

  console.log(`\n准备为账号 "${account.name}" 进行登录...\n`);

  // 启动有头浏览器
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();

  // 访问淘宝登录页
  await page.goto('https://login.taobao.com/member/login.jhtml');

  console.log('========================================');
  console.log('浏览器已打开，请完成以下操作：');
  console.log('1. 在浏览器中使用手机淘宝扫码登录');
  console.log('2. 登录成功后，回到此终端按 Enter 键');
  console.log('========================================\n');

  // 等待用户确认
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>((resolve) => {
    rl.question('登录完成后按 Enter 继续...', () => {
      rl.close();
      resolve();
    });
  });

  // 验证登录状态
  console.log('\n正在验证登录状态...');

  // 访问淘宝首页检查是否登录成功
  await page.goto('https://h5.m.taobao.com/');
  await page.waitForTimeout(2000);

  // 检查是否有用户信息
  const bodyText = await page
    .locator('body')
    .innerText({ timeout: 2000 })
    .catch(() => '');
  const isLoggedIn = !bodyText.includes('请登录');

  if (!isLoggedIn) {
    console.error('登录验证失败，请确保已成功登录');
    await browser.close();
    process.exit(1);
  }

  // 获取cookies
  const cookies = await context.cookies();
  const cookiesJson = JSON.stringify(cookies);

  // 保存到数据库
  await prisma.taobaoAccount.update({
    where: { id: accountId },
    data: {
      cookies: encryptCookies(cookiesJson),
      isActive: true,
      lastLoginAt: new Date(),
      status: 'IDLE',
      errorCount: 0,
      lastError: null,
    },
  });

  console.log('\n✅ 登录成功！Cookies已保存。');
  console.log(`账号 "${account.name}" 已激活，可以开始抓取。\n`);

  await browser.close();
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
