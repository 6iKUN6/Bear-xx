-- CreateEnum
CREATE TYPE "ConversationTraceItemType" AS ENUM ('STRATEGY_DECISION', 'SKILL_SELECTION', 'WORKFLOW_STEP', 'REACT_NODE', 'HYBRID_NODE', 'PLAN_NODE', 'MODEL_CALL', 'TOOL_CALL', 'MCP_CALL', 'MEMORY_READ', 'MEMORY_WRITE', 'MESSAGE_FINALIZE', 'ERROR');

-- CreateEnum
CREATE TYPE "ConversationTraceItemStatus" AS ENUM ('RUNNING', 'SUCCESS', 'ERROR', 'SKIPPED', 'CANCELED');

-- CreateTable
CREATE TABLE "conversation_turn_trace_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "task_id" TEXT,
    "run_id" TEXT,
    "parent_id" TEXT,
    "trace_key" TEXT,
    "sequence" INTEGER NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "type" "ConversationTraceItemType" NOT NULL,
    "status" "ConversationTraceItemStatus" NOT NULL DEFAULT 'RUNNING',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "detail" TEXT,
    "strategy" TEXT,
    "skill" TEXT,
    "graph" TEXT,
    "node_key" TEXT,
    "tool_name" TEXT,
    "mcp_server" TEXT,
    "mcp_tool" TEXT,
    "input_summary" JSONB,
    "output_summary" JSONB,
    "error" JSONB,
    "metrics" JSONB,
    "metadata" JSONB,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_turn_trace_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_turn_trace_items_task_id_trace_key_idx" ON "conversation_turn_trace_items"("task_id", "trace_key");

-- CreateIndex
CREATE INDEX "conversation_turn_trace_items_conversation_id_message_id_se_idx" ON "conversation_turn_trace_items"("conversation_id", "message_id", "sequence");

-- CreateIndex
CREATE INDEX "conversation_turn_trace_items_task_id_sequence_idx" ON "conversation_turn_trace_items"("task_id", "sequence");

-- CreateIndex
CREATE INDEX "conversation_turn_trace_items_run_id_idx" ON "conversation_turn_trace_items"("run_id");

-- CreateIndex
CREATE INDEX "conversation_turn_trace_items_parent_id_idx" ON "conversation_turn_trace_items"("parent_id");

-- CreateIndex
CREATE INDEX "conversation_turn_trace_items_type_idx" ON "conversation_turn_trace_items"("type");

-- AddForeignKey
ALTER TABLE "conversation_turn_trace_items" ADD CONSTRAINT "conversation_turn_trace_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turn_trace_items" ADD CONSTRAINT "conversation_turn_trace_items_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turn_trace_items" ADD CONSTRAINT "conversation_turn_trace_items_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turn_trace_items" ADD CONSTRAINT "conversation_turn_trace_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turn_trace_items" ADD CONSTRAINT "conversation_turn_trace_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "stream_task_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turn_trace_items" ADD CONSTRAINT "conversation_turn_trace_items_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "conversation_turn_trace_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
