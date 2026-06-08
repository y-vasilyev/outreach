-- Guided blogger discovery evidence loop (fix-guided-discovery-evidence-loop).
-- Closes the BUG #1/#2 race+dead-end: phase-1 search/scrape now runs ahead of
-- the per-candidate reviewer, and a non-terminal `enriching` run status holds
-- until the scrape→review loop closes (or a bounded sweep does). Adds the
-- atomic-claim guard that prevents duplicate review jobs from both spending
-- reviewer tokens, a channel_id index for the scrape hook's candidate lookup,
-- and a dedicated launch-provenance column kept out of `review` so a re-review
-- can't clobber it. Purely additive — no existing column/enum is dropped or
-- repurposed.

-- AlterEnum
ALTER TYPE "discovery_run_status" ADD VALUE 'enriching';

-- CreateIndex
CREATE INDEX "discovery_run_candidate_channel_id_idx" ON "discovery_run_candidate"("channel_id");

-- AlterTable
ALTER TABLE "discovery_run_candidate" ADD COLUMN "review_claimed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "discovery_run_candidate" ADD COLUMN "launched_campaign_id" TEXT;
