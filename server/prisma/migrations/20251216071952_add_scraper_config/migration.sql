-- CreateTable
CREATE TABLE "scraper_configs" (
    "id" TEXT NOT NULL,
    "minDelay" INTEGER NOT NULL DEFAULT 60,
    "maxDelay" INTEGER NOT NULL DEFAULT 180,
    "pollingInterval" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scraper_configs_pkey" PRIMARY KEY ("id")
);
