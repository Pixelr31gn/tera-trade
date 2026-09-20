-- CreateTable
CREATE TABLE "artifice_verdicts" (
    "id" SERIAL NOT NULL,
    "blueprint_id" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "merge_into_blueprint_id" INTEGER,
    "reasoning" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifice_verdicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "artifice_verdicts_blueprint_id_key" ON "artifice_verdicts"("blueprint_id");

-- CreateIndex
CREATE INDEX "artifice_verdicts_verdict_idx" ON "artifice_verdicts"("verdict");

-- AddForeignKey
ALTER TABLE "artifice_verdicts" ADD CONSTRAINT "artifice_verdicts_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "tailor_blueprints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
