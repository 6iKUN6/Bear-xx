-- AlterEnum
ALTER TYPE "AgentFlowAuditAction" ADD VALUE 'UPGRADED';

-- AlterTable
ALTER TABLE "agent_flow_audit_logs" ADD COLUMN     "upgrade_context" JSONB;
