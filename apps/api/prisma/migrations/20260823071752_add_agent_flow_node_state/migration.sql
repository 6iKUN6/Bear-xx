-- CreateTable
CREATE TABLE "agent_flow_node_states" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "node_execution_id" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_flow_node_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_flow_node_states_task_id_idx" ON "agent_flow_node_states"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_flow_node_states_task_id_node_execution_id_key" ON "agent_flow_node_states"("task_id", "node_execution_id");

-- AddForeignKey
ALTER TABLE "agent_flow_node_states" ADD CONSTRAINT "agent_flow_node_states_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
