-- CreateEnum
CREATE TYPE "StreamTaskType" AS ENUM ('CHAT_COMPLETION', 'VOICE_COMPLETION', 'AGENT_WORKFLOW');

-- CreateEnum
CREATE TYPE "StreamTaskStatus" AS ENUM ('PENDING', 'STREAMING', 'PAUSED', 'WAITING_HUMAN', 'COMPLETED', 'ERROR', 'EXPIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "StreamTaskRunStatus" AS ENUM ('PENDING', 'STREAMING', 'CLOSED', 'COMPLETED', 'ERROR', 'CANCELED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "stream_tasks" (
    "id" TEXT NOT NULL,
    "type" "StreamTaskType" NOT NULL,
    "status" "StreamTaskStatus" NOT NULL DEFAULT 'PENDING',
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "request_payload" JSONB NOT NULL,
    "execution_state" JSONB,
    "result_payload" JSONB,
    "current_agent" TEXT,
    "current_step" TEXT,
    "current_run_id" TEXT,
    "last_event_id" INTEGER NOT NULL DEFAULT 0,
    "full_content" TEXT NOT NULL DEFAULT '',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stream_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stream_task_runs" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "StreamTaskRunStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" TEXT,
    "start_event_id" INTEGER NOT NULL DEFAULT 0,
    "end_event_id" INTEGER,
    "close_reason" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stream_task_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stream_task_events" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "stream_id" TEXT,
    "event_id" INTEGER NOT NULL,
    "event_name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stream_task_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stream_tasks_user_id_status_idx" ON "stream_tasks"("user_id", "status");

-- CreateIndex
CREATE INDEX "stream_tasks_conversation_id_idx" ON "stream_tasks"("conversation_id");

-- CreateIndex
CREATE INDEX "stream_tasks_message_id_idx" ON "stream_tasks"("message_id");

-- CreateIndex
CREATE INDEX "stream_tasks_current_run_id_idx" ON "stream_tasks"("current_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "stream_task_runs_task_id_sequence_key" ON "stream_task_runs"("task_id", "sequence");

-- CreateIndex
CREATE INDEX "stream_task_runs_task_id_status_idx" ON "stream_task_runs"("task_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stream_task_events_task_id_event_id_key" ON "stream_task_events"("task_id", "event_id");

-- CreateIndex
CREATE INDEX "stream_task_events_task_id_event_id_idx" ON "stream_task_events"("task_id", "event_id");

-- CreateIndex
CREATE INDEX "stream_task_events_stream_id_idx" ON "stream_task_events"("stream_id");

-- AddForeignKey
ALTER TABLE "stream_tasks" ADD CONSTRAINT "stream_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_tasks" ADD CONSTRAINT "stream_tasks_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_tasks" ADD CONSTRAINT "stream_tasks_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_task_runs" ADD CONSTRAINT "stream_task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_task_events" ADD CONSTRAINT "stream_task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_task_events" ADD CONSTRAINT "stream_task_events_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "stream_task_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing single-stream SSE tasks into the new StreamTask tables.
INSERT INTO "stream_tasks" (
    "id",
    "type",
    "status",
    "user_id",
    "conversation_id",
    "message_id",
    "request_payload",
    "last_event_id",
    "full_content",
    "error_message",
    "started_at",
    "last_heartbeat_at",
    "completed_at",
    "expires_at",
    "created_at",
    "updated_at"
)
SELECT
    "id",
    "type"::text::"StreamTaskType",
    "status"::text::"StreamTaskStatus",
    "user_id",
    "conversation_id",
    "message_id",
    "request_payload",
    "last_event_id",
    "full_content",
    "error_message",
    "started_at",
    "last_heartbeat_at",
    "completed_at",
    "expires_at",
    "created_at",
    "updated_at"
FROM "sse_tasks";

INSERT INTO "stream_task_runs" (
    "id",
    "task_id",
    "sequence",
    "status",
    "trigger",
    "start_event_id",
    "end_event_id",
    "close_reason",
    "started_at",
    "ended_at",
    "created_at",
    "updated_at"
)
SELECT
    "id" || ':stream:1',
    "id",
    1,
    CASE
        WHEN "status" = 'PENDING' THEN 'PENDING'::"StreamTaskRunStatus"
        WHEN "status" = 'STREAMING' THEN 'STREAMING'::"StreamTaskRunStatus"
        WHEN "status" = 'PAUSED' THEN 'CLOSED'::"StreamTaskRunStatus"
        WHEN "status" = 'COMPLETED' THEN 'COMPLETED'::"StreamTaskRunStatus"
        WHEN "status" = 'ERROR' THEN 'ERROR'::"StreamTaskRunStatus"
        WHEN "status" = 'EXPIRED' THEN 'TIMEOUT'::"StreamTaskRunStatus"
        WHEN "status" = 'CANCELED' THEN 'CANCELED'::"StreamTaskRunStatus"
    END,
    'legacy_sse_task',
    0,
    CASE
        WHEN "status" IN ('COMPLETED', 'ERROR', 'EXPIRED', 'CANCELED') THEN "last_event_id"
        ELSE NULL
    END,
    CASE
        WHEN "status" = 'COMPLETED' THEN 'legacy_completed'
        WHEN "status" = 'ERROR' THEN 'legacy_error'
        WHEN "status" = 'EXPIRED' THEN 'legacy_expired'
        WHEN "status" = 'CANCELED' THEN 'legacy_canceled'
        ELSE NULL
    END,
    "started_at",
    CASE
        WHEN "status" IN ('COMPLETED', 'ERROR', 'EXPIRED', 'CANCELED') THEN "completed_at"
        ELSE NULL
    END,
    "created_at",
    "updated_at"
FROM "sse_tasks";

UPDATE "stream_tasks"
SET "current_run_id" = "id" || ':stream:1'
WHERE EXISTS (
    SELECT 1
    FROM "stream_task_runs"
    WHERE "stream_task_runs"."task_id" = "stream_tasks"."id"
);
