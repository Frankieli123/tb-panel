-- AlterTable: 添加购物车模式相关字段
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "skuId" TEXT,
  ADD COLUMN IF NOT EXISTS "skuProperties" TEXT,
  ADD COLUMN IF NOT EXISTS "cartItemId" TEXT,
  ADD COLUMN IF NOT EXISTS "monitorMode" TEXT NOT NULL DEFAULT 'PAGE',
  ADD COLUMN IF NOT EXISTS "ownerAccountId" TEXT;

-- CreateIndex: 为监控模式添加索引
CREATE INDEX IF NOT EXISTS "products_monitorMode_idx" ON "products"("monitorMode");

-- DropIndex: 移除taobaoId的唯一约束（因为多SKU会有多条记录）
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_taobaoId_key";

-- CreateIndex: 创建复合唯一索引（同一账号的同一SKU只能有一条）
CREATE UNIQUE INDEX IF NOT EXISTS "unique_sku_per_account" ON "products"("taobaoId", "skuId", "ownerAccountId");

-- AddForeignKey: 添加购物车模式的账号关联
ALTER TABLE "products" ADD CONSTRAINT "products_ownerAccountId_fkey"
  FOREIGN KEY ("ownerAccountId") REFERENCES "taobao_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
