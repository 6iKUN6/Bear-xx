-- CreateEnum
CREATE TYPE "AgentFlowNodeExecutionResultKind" AS ENUM ('COMPLETED', 'STOPPED_COMPLETED', 'STOPPED_CANCELLED', 'STOPPED_ERROR');

-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "flow_model_calls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "flow_run_started_at" TIMESTAMP(3),
ADD COLUMN     "flow_tool_calls" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "agent_flow_node_executions" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "node_execution_id" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "result" "AgentFlowNodeExecutionResultKind" NOT NULL,
    "outcome" TEXT,
    "summary" TEXT,
    "error_category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_flow_node_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_flow_node_executions_task_id_idx" ON "agent_flow_node_executions"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_flow_node_executions_task_id_node_execution_id_key" ON "agent_flow_node_executions"("task_id", "node_execution_id");

-- AddForeignKey
ALTER TABLE "agent_flow_node_executions" ADD CONSTRAINT "agent_flow_node_executions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
