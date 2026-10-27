-- CreateEnum
CREATE TYPE "StreamTaskRuntime" AS ENUM ('AGENT_FLOW', 'CHAT_AGENT');

-- AlterTable
ALTER TABLE "agent_flows" ADD COLUMN     "callable_as_tool" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "tool_groups" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "agent_tools_degraded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resolved_agent_tool_groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "runtime" "StreamTaskRuntime" NOT NULL DEFAULT 'AGENT_FLOW';
