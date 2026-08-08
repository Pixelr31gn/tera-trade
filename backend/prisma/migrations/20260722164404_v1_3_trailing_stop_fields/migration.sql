-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "let_it_ride" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trailing_stop_placed" BOOLEAN NOT NULL DEFAULT false;
