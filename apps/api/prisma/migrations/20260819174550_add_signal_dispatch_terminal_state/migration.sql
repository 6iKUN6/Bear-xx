-- AlterEnum
ALTER TYPE "AgentFlowSignalOutboxStatus" ADD VALUE 'FAILED';

-- DropIndex
DROP INDEX "agent_flow_signal_outbox_status_created_at_idx";

-- AlterTable
ALTER TABLE "agent_flow_signal_outbox" ADD COLUMN     "next_attempt_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "cancel_signal_settled_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "agent_flow_signal_outbox_status_next_attempt_at_created_at_idx" ON "agent_flow_signal_outbox"("status", "next_attempt_at", "created_at");
