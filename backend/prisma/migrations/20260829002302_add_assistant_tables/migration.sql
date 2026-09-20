-- AlterTable
ALTER TABLE "system_state" ADD COLUMN     "assistant_actions_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" SERIAL NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_actions" (
    "id" SERIAL NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "result_summary" TEXT NOT NULL,
    "raw_result" JSONB,
    "error_message" TEXT,
    "trade_id" INTEGER,
    "message_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_messages_created_at_idx" ON "assistant_messages"("created_at");

-- CreateIndex
CREATE INDEX "assistant_actions_created_at_idx" ON "assistant_actions"("created_at");

-- CreateIndex
CREATE INDEX "assistant_actions_trade_id_idx" ON "assistant_actions"("trade_id");

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
