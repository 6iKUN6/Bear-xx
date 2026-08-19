-- CreateEnum
CREATE TYPE "AgentFlowVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AgentFlowAuditAction" AS ENUM ('CREATED', 'DRAFT_UPDATED', 'IMPORTED', 'VALIDATED', 'PUBLISHED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "AgentFlowApprovalKind" AS ENUM ('TOOL', 'PLAN_REVIEW');

-- CreateEnum
CREATE TYPE "AgentFlowApprovalStatus" AS ENUM ('PENDING', 'RESOLVED', 'ERROR', 'CANCELED', 'TIMED_OUT');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "default_flow_version_id" TEXT;

-- AlterTable
ALTER TABLE "stream_tasks" ADD COLUMN     "flow_digest" TEXT,
ADD COLUMN     "flow_version_id" TEXT,
ADD COLUMN     "temporal_run_id" TEXT,
ADD COLUMN     "temporal_workflow_id" TEXT;

-- CreateTable
CREATE TABLE "agent_flows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "published_version_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_flow_versions" (
    "id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AgentFlowVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "digest" TEXT,
    "schema_version" INTEGER NOT NULL,
    "created_by_id" TEXT,
    "published_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_flow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_flow_audit_logs" (
    "id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "version_id" TEXT,
    "action" "AgentFlowAuditAction" NOT NULL,
    "actor_id" TEXT,
    "digest" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_flow_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_flow_approvals" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "run_id" TEXT,
    "trace_item_id" TEXT,
    "node_key" TEXT NOT NULL,
    "kind" "AgentFlowApprovalKind" NOT NULL,
    "status" "AgentFlowApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "request_summary" JSONB NOT NULL,
    "decision" JSONB,
    "decided_at" TIMESTAMP(3),
    "decided_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_flow_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_flows_published_version_id_key" ON "agent_flows"("published_version_id");

-- CreateIndex
CREATE INDEX "agent_flows_created_by_id_idx" ON "agent_flows"("created_by_id");

-- CreateIndex
CREATE INDEX "agent_flow_versions_flow_id_status_idx" ON "agent_flow_versions"("flow_id", "status");

-- CreateIndex
CREATE INDEX "agent_flow_versions_created_by_id_idx" ON "agent_flow_versions"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_flow_versions_flow_id_version_key" ON "agent_flow_versions"("flow_id", "version");

-- CreateIndex
CREATE INDEX "agent_flow_audit_logs_flow_id_created_at_idx" ON "agent_flow_audit_logs"("flow_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_flow_audit_logs_version_id_created_at_idx" ON "agent_flow_audit_logs"("version_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_flow_audit_logs_actor_id_created_at_idx" ON "agent_flow_audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_flow_approvals_trace_item_id_key" ON "agent_flow_approvals"("trace_item_id");

-- CreateIndex
CREATE INDEX "agent_flow_approvals_task_id_status_idx" ON "agent_flow_approvals"("task_id", "status");

-- CreateIndex
CREATE INDEX "agent_flow_approvals_run_id_idx" ON "agent_flow_approvals"("run_id");

-- CreateIndex
CREATE INDEX "agent_flow_approvals_decided_by_id_idx" ON "agent_flow_approvals"("decided_by_id");

-- CreateIndex
CREATE INDEX "agents_default_flow_version_id_idx" ON "agents"("default_flow_version_id");

-- CreateIndex
CREATE INDEX "stream_tasks_flow_version_id_idx" ON "stream_tasks"("flow_version_id");

-- CreateIndex
CREATE INDEX "stream_tasks_temporal_workflow_id_idx" ON "stream_tasks"("temporal_workflow_id");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_flow_version_id_fkey" FOREIGN KEY ("default_flow_version_id") REFERENCES "agent_flow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flows" ADD CONSTRAINT "agent_flows_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flows" ADD CONSTRAINT "agent_flows_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "agent_flow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_versions" ADD CONSTRAINT "agent_flow_versions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "agent_flows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_versions" ADD CONSTRAINT "agent_flow_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_audit_logs" ADD CONSTRAINT "agent_flow_audit_logs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "agent_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_audit_logs" ADD CONSTRAINT "agent_flow_audit_logs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "agent_flow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_audit_logs" ADD CONSTRAINT "agent_flow_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_tasks" ADD CONSTRAINT "stream_tasks_flow_version_id_fkey" FOREIGN KEY ("flow_version_id") REFERENCES "agent_flow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_approvals" ADD CONSTRAINT "agent_flow_approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_approvals" ADD CONSTRAINT "agent_flow_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "stream_task_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_approvals" ADD CONSTRAINT "agent_flow_approvals_trace_item_id_fkey" FOREIGN KEY ("trace_item_id") REFERENCES "conversation_turn_trace_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_flow_approvals" ADD CONSTRAINT "agent_flow_approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
