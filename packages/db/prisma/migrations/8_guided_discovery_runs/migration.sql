-- Guided blogger discovery (ajtbd-guided-blogger-discovery change).
-- Adds first-class run + candidate tables for the AJTBD-guided discovery
-- workbench. Trace events live as JSON on the run (an operator-visible
-- product surface); candidates are a separate table so per-candidate
-- operator decisions (save/shortlist/reject) and scrape-refresh persist
-- without rewriting the run blob. Purely additive — no existing table or
-- enum is touched.

-- CreateEnum
CREATE TYPE "discovery_run_status" AS ENUM ('pending', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "discovery_run" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "input" JSONB NOT NULL,
    "status" "discovery_run_status" NOT NULL DEFAULT 'pending',
    "planned_queries" JSONB NOT NULL DEFAULT '[]',
    "trace" JSONB NOT NULL DEFAULT '[]',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "discovery_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_run_candidate" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "platform" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "enrichment_status" TEXT NOT NULL DEFAULT 'new',
    "review" JSONB,
    "score" DECIMAL(65,30),
    "recommendation" TEXT,
    "decision" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_run_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discovery_run_status_created_at_idx" ON "discovery_run"("status", "created_at");

-- CreateIndex
CREATE INDEX "discovery_run_created_by_id_idx" ON "discovery_run"("created_by_id");

-- CreateIndex
CREATE INDEX "discovery_run_candidate_run_id_idx" ON "discovery_run_candidate"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_run_candidate_run_id_platform_handle_key" ON "discovery_run_candidate"("run_id", "platform", "handle");

-- AddForeignKey
ALTER TABLE "discovery_run_candidate" ADD CONSTRAINT "discovery_run_candidate_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "discovery_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
