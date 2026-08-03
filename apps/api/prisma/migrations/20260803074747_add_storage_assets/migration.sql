-- CreateEnum
CREATE TYPE "StorageAssetKind" AS ENUM ('IMAGE', 'AUDIO');

-- CreateEnum
CREATE TYPE "StorageAssetStatus" AS ENUM ('ACTIVE', 'BROKEN', 'DELETED');

-- CreateTable
CREATE TABLE "storage_assets" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "StorageAssetKind" NOT NULL,
    "usage" TEXT NOT NULL DEFAULT '',
    "mime_type" TEXT,
    "size" INTEGER,
    "status" "StorageAssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "uploaded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_assets_key_key" ON "storage_assets"("key");

-- CreateIndex
CREATE INDEX "storage_assets_usage_status_created_at_idx" ON "storage_assets"("usage", "status", "created_at");

-- CreateIndex
CREATE INDEX "storage_assets_uploaded_by_id_idx" ON "storage_assets"("uploaded_by_id");

-- AddForeignKey
ALTER TABLE "storage_assets" ADD CONSTRAINT "storage_assets_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
