-- AlterTable: add ownership for multi-tenant isolation
ALTER TABLE "taobao_accounts"
  ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- AddForeignKey: taobao_accounts.userId -> system_users.id
DO $$
BEGIN
  ALTER TABLE "taobao_accounts"
    ADD CONSTRAINT "taobao_accounts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "system_users"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateIndex: speed up per-user filtering
CREATE INDEX IF NOT EXISTS "taobao_accounts_userId_idx" ON "taobao_accounts"("userId");

