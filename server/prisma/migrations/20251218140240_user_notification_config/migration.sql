-- CreateTable
CREATE TABLE "user_notification_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailAddress" TEXT,
    "wechatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "wechatWebhook" TEXT,
    "dingtalkEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dingtalkWebhook" TEXT,
    "feishuEnabled" BOOLEAN NOT NULL DEFAULT false,
    "feishuWebhook" TEXT,
    "triggerType" "TriggerType" NOT NULL DEFAULT 'AMOUNT',
    "triggerValue" DECIMAL(10,2) NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_configs_userId_key" ON "user_notification_configs"("userId");

-- AddForeignKey
ALTER TABLE "user_notification_configs" ADD CONSTRAINT "user_notification_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "system_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
