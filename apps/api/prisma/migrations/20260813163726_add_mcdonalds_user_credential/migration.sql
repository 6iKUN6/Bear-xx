/*
  Warnings:

  - A unique constraint covering the columns `[user_id,credential_id,external_order_id]` on the table `mcdonalds_orders` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "McDonaldsCredentialStatus" AS ENUM ('ACTIVE', 'INVALID', 'REVOKED');

-- CreateEnum
CREATE TYPE "McpConnectionAuditOperation" AS ENUM ('CREDENTIAL_BIND_VERIFICATION');

-- CreateEnum
CREATE TYPE "McpConnectionAuditStatus" AS ENUM ('SUCCESS', 'ERROR');

-- DropIndex
DROP INDEX "mcdonalds_orders_user_id_external_order_id_key";

-- AlterTable
ALTER TABLE "mcdonalds_orders" ADD COLUMN     "credential_id" TEXT;

-- CreateTable
CREATE TABLE "mcdonalds_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "token_fingerprint" TEXT NOT NULL,
    "status" "McDonaldsCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "verified_at" TIMESTAMP(3),
    "last_error" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcdonalds_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_connection_audits" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT,
    "mcp_server" TEXT NOT NULL,
    "operation" "McpConnectionAuditOperation" NOT NULL,
    "mcp_tool" TEXT,
    "status" "McpConnectionAuditStatus" NOT NULL,
    "duration_ms" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_connection_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcdonalds_credentials_user_id_status_idx" ON "mcdonalds_credentials"("user_id", "status");

-- CreateIndex
CREATE INDEX "mcdonalds_credentials_user_id_token_fingerprint_idx" ON "mcdonalds_credentials"("user_id", "token_fingerprint");

-- CreateIndex
CREATE INDEX "mcp_connection_audits_user_id_created_at_idx" ON "mcp_connection_audits"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_connection_audits_credential_id_created_at_idx" ON "mcp_connection_audits"("credential_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_connection_audits_mcp_server_status_created_at_idx" ON "mcp_connection_audits"("mcp_server", "status", "created_at");

-- CreateIndex
CREATE INDEX "mcdonalds_orders_credential_id_idx" ON "mcdonalds_orders"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcdonalds_orders_user_id_credential_id_external_order_id_key" ON "mcdonalds_orders"("user_id", "credential_id", "external_order_id");

-- AddForeignKey
ALTER TABLE "mcdonalds_credentials" ADD CONSTRAINT "mcdonalds_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_connection_audits" ADD CONSTRAINT "mcp_connection_audits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_connection_audits" ADD CONSTRAINT "mcp_connection_audits_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "mcdonalds_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcdonalds_orders" ADD CONSTRAINT "mcdonalds_orders_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "mcdonalds_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
