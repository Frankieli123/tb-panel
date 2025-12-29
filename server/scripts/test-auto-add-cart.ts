import { PrismaClient } from '@prisma/client';
import { autoCartAdder } from '../src/services/autoCartAdder.js';
import { cartScraper } from '../src/services/cartScraper.js';

const prisma = new PrismaClient();

const CART_BASE_SKU_ID = '__BASE__';

async function testAutoAddToCart() {
  console.log('🧪 测试自动加购功能（真人模式）...\n');

  try {
    // 1. 获取活跃账号
    const account = await prisma.taobaoAccount.findFirst({
      where: { isActive: true }
    });

    if (!account) {
      console.error('❌ 没有找到活跃的淘宝账号');
      return;
    }

    console.log(`✅ 使用账号: ${account.name} (ID: ${account.id})\n`);

    // 2. 测试商品
    const testProductUrl = 'https://detail.tmall.com/item.htm?id=875765952236';
    const taobaoId = '875765952236';

    console.log(`📦 测试商品: ${testProductUrl}`);
    console.log(`📍 商品ID: ${taobaoId}\n`);

    console.log('⚙️  开始自动加购所有SKU（真人可见模式）...\n');
    console.log('=' .repeat(80));

    const startTime = Date.now();

    // 3. 执行自动加购（非headless模式，可以看到浏览器操作）
    const result = await autoCartAdder.addAllSkusToCart(
      account.id,
      taobaoId,
      account.cookies,
      { headless: false }  // 真人模式：显示浏览器窗口
    );

    const duration = Date.now() - startTime;

    console.log('\n' + '='.repeat(80));
    console.log('\n📊 加购结果汇总：\n');
    console.log(`✅ 成功: ${result.successCount}/${result.totalSkus}`);
    console.log(`❌ 失败: ${result.failedCount}/${result.totalSkus}`);
    console.log(`⏱️  总耗时: ${(duration / 1000).toFixed(2)}秒`);
    console.log(`⚡ 平均每个SKU: ${(duration / result.totalSkus / 1000).toFixed(2)}秒\n`);

    console.log('📋 详细结果：\n');
    result.results.forEach((r, idx) => {
      const status = r.success ? '✅' : '❌';
      console.log(`${status} [${idx + 1}/${result.totalSkus}] ${r.skuProperties}`);
      if (!r.success) {
        console.log(`   错误: ${r.error}`);
      }
    });

    console.log('\n' + '='.repeat(80));

    // 4. 保存到数据库（单商品多SKU：只落一条 base Product，SKU 数据写到 snapshot.variants）
    if (result.successCount > 0) {
      console.log('\n💾 保存到数据库...\n');

      await prisma.product.upsert({
        where: {
          unique_sku_per_account: {
            taobaoId,
            skuId: CART_BASE_SKU_ID,
            ownerAccountId: account.id
          }
        },
        update: {
          monitorMode: 'CART',
          ownerAccountId: account.id,
          url: testProductUrl,
          isActive: true,
          lastError: null
        },
        create: {
          taobaoId,
          skuId: CART_BASE_SKU_ID,
          monitorMode: 'CART',
          ownerAccountId: account.id,
          url: testProductUrl,
          isActive: true
        }
      });

      await cartScraper.updatePricesFromCart(account.id, account.cookies);
      console.log('✅ 已写入购物车SKU快照');
    }

    console.log('\n✅ 测试完成！\n');

  } catch (error: any) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

testAutoAddToCart();
