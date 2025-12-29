-- Default monitorMode to CART (detail-page mode removed)
ALTER TABLE "products" ALTER COLUMN "monitorMode" SET DEFAULT 'CART';
