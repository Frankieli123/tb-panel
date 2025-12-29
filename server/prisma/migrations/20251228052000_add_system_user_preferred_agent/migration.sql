-- AlterTable: per-user default execution agent
ALTER TABLE "system_users"
  ADD COLUMN IF NOT EXISTS "preferredAgentId" TEXT;

-- CreateIndex: speed up filtering/lookup
CREATE INDEX IF NOT EXISTS "system_users_preferredAgentId_idx" ON "system_users"("preferredAgentId");

