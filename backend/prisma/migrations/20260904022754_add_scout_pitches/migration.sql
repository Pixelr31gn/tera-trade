-- CreateTable
CREATE TABLE "scout_pitches" (
    "id" SERIAL NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "proposed_agent" TEXT NOT NULL,
    "tools_needed" JSONB NOT NULL,
    "cost_estimate" TEXT NOT NULL,
    "frequency_estimate" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "evidence_log" JSONB NOT NULL DEFAULT '[]',
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'open',
    "score" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "rating" INTEGER,
    "rating_note" TEXT,
    "rated_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scout_pitches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scout_digests" (
    "id" SERIAL NOT NULL,
    "digest_date" DATE NOT NULL,
    "content" TEXT NOT NULL,
    "pitch_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scout_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scout_pitches_dedupe_key_key" ON "scout_pitches"("dedupe_key");

-- CreateIndex
CREATE INDEX "scout_pitches_status_score_idx" ON "scout_pitches"("status", "score");

-- CreateIndex
CREATE UNIQUE INDEX "scout_digests_digest_date_key" ON "scout_digests"("digest_date");
