/*
  Warnings:

  - You are about to drop the column `allowed_strategies` on the `agents` table. All the data in the column will be lost.
  - You are about to drop the column `default_strategy` on the `agents` table. All the data in the column will be lost.
  - You are about to drop the column `max_steps` on the `agents` table. All the data in the column will be lost.
  - You are about to drop the column `skills` on the `agents` table. All the data in the column will be lost.
  - You are about to drop the column `tool_groups` on the `agents` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "agents" DROP COLUMN "allowed_strategies",
DROP COLUMN "default_strategy",
DROP COLUMN "max_steps",
DROP COLUMN "skills",
DROP COLUMN "tool_groups";

-- DropEnum
DROP TYPE "AgentStrategy";
