/*
  Warnings:

  - You are about to drop the column `provider` on the `model_presets` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ModelUpstreamFormat" AS ENUM ('OPENAI_CHAT_COMPLETIONS', 'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES');

-- CreateEnum
CREATE TYPE "ModelPresetCapability" AS ENUM ('UNVERIFIED', 'UNREACHABLE', 'BASIC', 'TOOLS');

-- AlterTable
ALTER TABLE "model_presets" DROP COLUMN "provider",
ADD COLUMN     "api_key_ciphertext" TEXT,
ADD COLUMN     "api_key_fingerprint" TEXT,
ADD COLUMN     "capability" "ModelPresetCapability" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "last_check_error" TEXT,
ADD COLUMN     "last_checked_at" TIMESTAMP(3),
ADD COLUMN     "upstream_format" "ModelUpstreamFormat" NOT NULL DEFAULT 'OPENAI_CHAT_COMPLETIONS';
