-- CreateEnum
CREATE TYPE "MembershipTier" AS ENUM ('FREE', 'PLUS', 'PRO');

-- CreateEnum
CREATE TYPE "ManagementAuditTargetType" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "ManagementAuditAction" AS ENUM ('ADMIN_ROLE_UPDATED', 'MEMBERSHIP_UPDATED', 'AGENT_ACCESS_UPDATED', 'SUPER_ADMIN_BOOTSTRAPPED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'SUPER_ADMIN';

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "minimum_membership_tier" "MembershipTier" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "visible" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "membership_expires_at" TIMESTAMP(3),
ADD COLUMN     "membership_tier" "MembershipTier" NOT NULL DEFAULT 'FREE';

-- CreateTable
CREATE TABLE "management_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "target_type" "ManagementAuditTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "action" "ManagementAuditAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "management_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "management_audit_logs_actor_id_created_at_idx" ON "management_audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "management_audit_logs_target_type_target_id_created_at_idx" ON "management_audit_logs"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "agents_visible_idx" ON "agents"("visible");

-- CreateIndex
CREATE INDEX "agents_minimum_membership_tier_idx" ON "agents"("minimum_membership_tier");

-- AddForeignKey
ALTER TABLE "management_audit_logs" ADD CONSTRAINT "management_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
