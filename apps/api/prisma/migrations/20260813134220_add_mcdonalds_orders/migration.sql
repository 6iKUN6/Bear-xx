-- CreateEnum
CREATE TYPE "McDonaldsOrderRefreshStatus" AS ENUM ('SUCCESS', 'ERROR');

-- CreateTable
CREATE TABLE "mcdonalds_orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "task_id" TEXT,
    "external_order_id" TEXT NOT NULL,
    "status" TEXT,
    "status_label" TEXT,
    "store_code" TEXT,
    "store_name" TEXT,
    "order_type" INTEGER,
    "fulfillment_type" TEXT,
    "estimated_fulfillment_at" TIMESTAMP(3),
    "total_amount" DECIMAL(12,2),
    "discount_amount" DECIMAL(12,2),
    "currency" TEXT DEFAULT 'CNY',
    "items" JSONB,
    "raw_snapshot" JSONB,
    "payment_url_ciphertext" TEXT,
    "payment_url_expires_at" TIMESTAMP(3),
    "last_refreshed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcdonalds_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcdonalds_order_refreshes" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" "McDonaldsOrderRefreshStatus" NOT NULL,
    "status_after" TEXT,
    "error_message" TEXT,
    "safe_snapshot" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcdonalds_order_refreshes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcdonalds_orders_user_id_created_at_idx" ON "mcdonalds_orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "mcdonalds_orders_message_id_idx" ON "mcdonalds_orders"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcdonalds_orders_user_id_external_order_id_key" ON "mcdonalds_orders"("user_id", "external_order_id");

-- CreateIndex
CREATE INDEX "mcdonalds_order_refreshes_order_id_created_at_idx" ON "mcdonalds_order_refreshes"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "mcdonalds_orders" ADD CONSTRAINT "mcdonalds_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcdonalds_orders" ADD CONSTRAINT "mcdonalds_orders_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcdonalds_orders" ADD CONSTRAINT "mcdonalds_orders_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcdonalds_orders" ADD CONSTRAINT "mcdonalds_orders_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "stream_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcdonalds_order_refreshes" ADD CONSTRAINT "mcdonalds_order_refreshes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "mcdonalds_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
