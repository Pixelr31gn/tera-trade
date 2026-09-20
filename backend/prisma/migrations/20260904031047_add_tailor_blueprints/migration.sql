-- CreateTable
CREATE TABLE "tailor_blueprints" (
    "id" SERIAL NOT NULL,
    "pitch_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "pitch_rating_at_generation" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tailor_blueprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tailor_blueprints_pitch_id_key" ON "tailor_blueprints"("pitch_id");

-- AddForeignKey
ALTER TABLE "tailor_blueprints" ADD CONSTRAINT "tailor_blueprints_pitch_id_fkey" FOREIGN KEY ("pitch_id") REFERENCES "scout_pitches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
