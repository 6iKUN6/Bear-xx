-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "avatar" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "agent_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "agent_id" TEXT;
