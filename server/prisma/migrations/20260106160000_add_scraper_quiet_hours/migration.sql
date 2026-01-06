-- AlterTable
ALTER TABLE "scraper_configs" ADD COLUMN "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "scraper_configs" ADD COLUMN "quietHoursStart" TEXT NOT NULL DEFAULT '00:00';
ALTER TABLE "scraper_configs" ADD COLUMN "quietHoursEnd" TEXT NOT NULL DEFAULT '00:00';

