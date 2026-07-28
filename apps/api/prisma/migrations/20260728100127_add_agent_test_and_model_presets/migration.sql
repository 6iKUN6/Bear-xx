-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "is_test" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "model_presets" (
    "id" TEXT NOT NULL,
    "preset_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "base_url" TEXT,
    "temperature" DOUBLE PRECISION,
    "max_output_tokens" INTEGER,
    "top_p" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_presets_preset_id_key" ON "model_presets"("preset_id");

-- CreateIndex
CREATE INDEX "model_presets_enabled_idx" ON "model_presets"("enabled");

-- CreateIndex
CREATE INDEX "model_presets_is_default_idx" ON "model_presets"("is_default");

-- CreateIndex
CREATE INDEX "stream_tasks_is_test_idx" ON "stream_tasks"("is_test");
