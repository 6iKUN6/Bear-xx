/*
  Warnings:

  - You are about to drop the column `model_preset` on the `agents` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "agents" DROP COLUMN "model_preset",
ADD COLUMN     "default_model_preset_id" TEXT;

-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "resolved_agent_model_preset_id" TEXT;

-- CreateTable
CREATE TABLE "agent_allowed_model_presets" (
    "agent_id" TEXT NOT NULL,
    "model_preset_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_allowed_model_presets_pkey" PRIMARY KEY ("agent_id","model_preset_id")
);

-- CreateIndex
CREATE INDEX "agent_allowed_model_presets_model_preset_id_idx" ON "agent_allowed_model_presets"("model_preset_id");

-- CreateIndex
CREATE INDEX "agents_default_model_preset_id_idx" ON "agents"("default_model_preset_id");

-- CreateIndex
CREATE INDEX "stream_tasks_resolved_agent_model_preset_id_idx" ON "stream_tasks"("resolved_agent_model_preset_id");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_model_preset_id_fkey" FOREIGN KEY ("default_model_preset_id") REFERENCES "model_presets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_allowed_model_presets" ADD CONSTRAINT "agent_allowed_model_presets_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_allowed_model_presets" ADD CONSTRAINT "agent_allowed_model_presets_model_preset_id_fkey" FOREIGN KEY ("model_preset_id") REFERENCES "model_presets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
