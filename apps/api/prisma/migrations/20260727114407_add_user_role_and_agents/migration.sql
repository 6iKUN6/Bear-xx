-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AgentStrategy" AS ENUM ('AUTO', 'DIRECT', 'REACT', 'PLAN_EXECUTE', 'HYBRID');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "system_prompt" TEXT,
    "model_preset" TEXT,
    "default_strategy" "AgentStrategy" NOT NULL DEFAULT 'AUTO',
    "allowed_strategies" "AgentStrategy"[] DEFAULT ARRAY[]::"AgentStrategy"[],
    "tool_groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_steps" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_enabled_idx" ON "agents"("enabled");

-- CreateIndex
CREATE INDEX "agents_is_default_idx" ON "agents"("is_default");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
