-- AlterTable
ALTER TABLE "invite_codes" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
