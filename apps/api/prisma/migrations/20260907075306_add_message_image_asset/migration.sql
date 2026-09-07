-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "image_asset_id" TEXT;

-- CreateIndex
CREATE INDEX "messages_image_asset_id_idx" ON "messages"("image_asset_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_image_asset_id_fkey" FOREIGN KEY ("image_asset_id") REFERENCES "storage_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
