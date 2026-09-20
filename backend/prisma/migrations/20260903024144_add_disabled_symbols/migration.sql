-- CreateTable
CREATE TABLE "disabled_symbols" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disabled_symbols_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disabled_symbols_symbol_key" ON "disabled_symbols"("symbol");
