-- 9d_discovery_batch
--
-- Batch channel discovery (batch-channel-discovery change). One row per
-- async batch request — keeps the input + worker progress so an operator
-- can poll status and come back to a long-running batch later. The
-- worker iterates `queries` and updates `summary` (per-niche records +
-- totals) as each niche finishes; on terminal status `completedAt` is
-- filled and `status` flips to `done` (or `failed` if the worker
-- itself crashed before processing any niche). See openspec change
-- `batch-channel-discovery`.

CREATE TYPE "DiscoveryBatchStatus" AS ENUM ('pending', 'running', 'done', 'failed');

CREATE TABLE "DiscoveryBatch" (
    "id"            TEXT NOT NULL,
    "queries"       JSONB NOT NULL,
    "platform"      TEXT,
    "limitPerQuery" INT NOT NULL DEFAULT 20,
    "status"        "DiscoveryBatchStatus" NOT NULL DEFAULT 'pending',
    "summary"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdById"   TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "completedAt"   TIMESTAMP(3),

    CONSTRAINT "DiscoveryBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiscoveryBatch_status_createdAt_idx" ON "DiscoveryBatch" ("status", "createdAt");
CREATE INDEX "DiscoveryBatch_createdById_idx" ON "DiscoveryBatch" ("createdById");
