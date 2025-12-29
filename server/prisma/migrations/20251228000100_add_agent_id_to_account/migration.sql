-- AlterTable: add agent binding for browser execution
ALTER TABLE "taobao_accounts"
  ADD COLUMN IF NOT EXISTS "agentId" TEXT;

-- CreateIndex: speed up agent routing
CREATE INDEX IF NOT EXISTS "taobao_accounts_agentId_idx" ON "taobao_accounts"("agentId");

