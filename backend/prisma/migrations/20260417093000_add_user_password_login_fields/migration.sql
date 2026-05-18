ALTER TABLE "users"
ADD COLUMN "username" TEXT,
ADD COLUMN "password_hash" TEXT,
ADD COLUMN "password_updated_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
