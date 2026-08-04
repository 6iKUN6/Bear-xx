-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('SINGLE', 'GROUP');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "default_agent_id" TEXT,
ADD COLUMN     "type" "ConversationType" NOT NULL DEFAULT 'SINGLE';
