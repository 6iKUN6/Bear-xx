-- AlterTable
ALTER TABLE "conversation_summaries" ADD COLUMN     "source_digest" TEXT;

-- AlterTable
ALTER TABLE "model_presets" ADD COLUMN     "context_window_tokens" INTEGER;

-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "context_message_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
