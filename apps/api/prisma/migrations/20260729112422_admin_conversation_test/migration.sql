-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "is_test" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "conversations_user_id_is_test_idx" ON "conversations"("user_id", "is_test");
