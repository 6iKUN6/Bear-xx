-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "agent_id" TEXT;

-- CreateIndex
CREATE INDEX "stream_tasks_agent_id_idx" ON "stream_tasks"("agent_id");
