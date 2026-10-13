-- CreateTable
CREATE TABLE "agent_flow_node_contexts" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "node_execution_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_flow_node_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_flow_node_contexts_task_id_node_execution_id_phase_key" ON "agent_flow_node_contexts"("task_id", "node_execution_id", "phase");

-- AddForeignKey
ALTER TABLE "agent_flow_node_contexts" ADD CONSTRAINT "agent_flow_node_contexts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
