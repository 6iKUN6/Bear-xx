-- AlterEnum
ALTER TYPE "ModelUpstreamFormat" ADD VALUE 'GEMINI_GENERATE_CONTENT';

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "default_reasoning_config" JSONB;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "model_context" JSONB;

-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "resolved_agent_reasoning_config" JSONB;
