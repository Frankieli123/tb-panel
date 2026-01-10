-- AlterTable
ALTER TABLE "scraper_configs" ADD COLUMN "cartAddSkuDelayMinMs" INTEGER NOT NULL DEFAULT 900;
ALTER TABLE "scraper_configs" ADD COLUMN "cartAddSkuDelayMaxMs" INTEGER NOT NULL DEFAULT 2200;
ALTER TABLE "scraper_configs" ADD COLUMN "cartAddProductDelayMinMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "scraper_configs" ADD COLUMN "cartAddProductDelayMaxMs" INTEGER NOT NULL DEFAULT 0;
