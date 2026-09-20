-- CreateTable
CREATE TABLE "disabled_strategy_symbols" (
    "id" SERIAL NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disabled_strategy_symbols_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disabled_strategy_symbols_strategy_id_symbol_key" ON "disabled_strategy_symbols"("strategy_id", "symbol");
