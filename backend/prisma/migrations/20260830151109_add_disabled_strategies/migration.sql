-- CreateTable
CREATE TABLE "disabled_strategies" (
    "id" SERIAL NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disabled_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disabled_strategies_strategy_id_key" ON "disabled_strategies"("strategy_id");
