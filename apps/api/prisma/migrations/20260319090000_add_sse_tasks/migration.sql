-- CreateEnum
CREATE TYPE "SseTaskType" AS ENUM ('CHAT_COMPLETION', 'VOICE_COMPLETION');

-- CreateEnum
CREATE TYPE "SseTaskStatus" AS ENUM ('PENDING', 'STREAMING', 'PAUSED', 'COMPLETED', 'ERROR', 'EXPIRED', 'CANCELED');

-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'STREAMING';

-- CreateTable
CREATE TABLE "sse_tasks" (
    "id" TEXT NOT NULL,
    "type" "SseTaskType" NOT NULL,
    "status" "SseTaskStatus" NOT NULL DEFAULT 'PENDING',
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "request_payload" JSONB NOT NULL,
    "last_event_id" INTEGER NOT NULL DEFAULT 0,
    "full_content" TEXT NOT NULL DEFAULT '',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sse_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sse_tasks_user_id_status_idx" ON "sse_tasks"("user_id", "status");

-- CreateIndex
CREATE INDEX "sse_tasks_conversation_id_idx" ON "sse_tasks"("conversation_id");

-- CreateIndex
CREATE INDEX "sse_tasks_message_id_idx" ON "sse_tasks"("message_id");

-- AddForeignKey
ALTER TABLE "sse_tasks" ADD CONSTRAINT "sse_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sse_tasks" ADD CONSTRAINT "sse_tasks_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sse_tasks" ADD CONSTRAINT "sse_tasks_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
