/*
  Warnings:

  - You are about to drop the column `api_key_ciphertext` on the `model_presets` table. All the data in the column will be lost.
  - You are about to drop the column `api_key_fingerprint` on the `model_presets` table. All the data in the column will be lost.
  - You are about to drop the column `base_url` on the `model_presets` table. All the data in the column will be lost.
  - You are about to drop the column `platform` on the `model_presets` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[connection_id,model]` on the table `model_presets` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `connection_id` to the `model_presets` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ModelProviderConnectionStatus" AS ENUM ('UNVERIFIED', 'REACHABLE', 'UNREACHABLE');

-- AlterTable
ALTER TABLE "model_presets" DROP COLUMN "api_key_ciphertext",
DROP COLUMN "api_key_fingerprint",
DROP COLUMN "base_url",
DROP COLUMN "platform",
ADD COLUMN     "connection_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "model_provider_connections" (
    "id" TEXT NOT NULL,
    "connection_key" TEXT NOT NULL,
    "provider_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "api_key_ciphertext" TEXT NOT NULL,
    "api_key_fingerprint" TEXT NOT NULL,
    "status" "ModelProviderConnectionStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "last_checked_at" TIMESTAMP(3),
    "last_check_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_provider_connections_connection_key_key" ON "model_provider_connections"("connection_key");

-- CreateIndex
CREATE INDEX "model_provider_connections_provider_key_idx" ON "model_provider_connections"("provider_key");

-- CreateIndex
CREATE INDEX "model_provider_connections_enabled_idx" ON "model_provider_connections"("enabled");

-- CreateIndex
CREATE INDEX "model_presets_connection_id_idx" ON "model_presets"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_presets_connection_id_model_key" ON "model_presets"("connection_id", "model");

-- AddForeignKey
ALTER TABLE "model_presets" ADD CONSTRAINT "model_presets_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "model_provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
