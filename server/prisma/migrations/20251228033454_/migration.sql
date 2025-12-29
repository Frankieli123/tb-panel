-- DropIndex
DROP INDEX "products_taobaoId_key";

-- DropIndex
DROP INDEX "taobao_accounts_agentId_idx";

-- RenameIndex
ALTER INDEX "unique_sku_per_account" RENAME TO "products_taobaoId_skuId_ownerAccountId_key";
