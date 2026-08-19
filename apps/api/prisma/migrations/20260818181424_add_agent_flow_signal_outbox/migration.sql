-- CreateEnum
CREATE TYPE "AgentFlowSignalOutboxStatus" AS ENUM ('PENDING', 'SENDING', 'DELIVERED');

-- CreateTable
CREATE TABLE "agent_flow_signal_outbox" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "status" "AgentFlowSignalOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_flow_signal_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_flow_signal_outbox_approval_id_key" ON "agent_flow_signal_outbox"("approval_id");

-- CreateIndex
CREATE INDEX "agent_flow_signal_outbox_status_created_at_idx" ON "agent_flow_signal_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "agent_flow_signal_outbox_task_id_idx" ON "agent_flow_signal_outbox"("task_id");

-- CreateIndex
CREATE INDEX "agent_flow_signal_outbox_created_by_id_idx" ON "agent_flow_signal_outbox"("created_by_id");

-- AddForeignKey
ALTER TABLE "agent_flow_signal_outbox" ADD CONSTRAINT "agent_flow_signal_outbox_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_signal_outbox" ADD CONSTRAINT "agent_flow_signal_outbox_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "agent_flow_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_signal_outbox" ADD CONSTRAINT "agent_flow_signal_outbox_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
