-- Operator re-analysis + markup (operator-reanalyze-and-markup).
-- Makes extraction observable (per-message status), re-runnable (supersede),
-- correctable (operator data points), and teachable (extraction hints fed to
-- the extractor agents). Purely additive — defaults keep existing rows valid.

-- AlterTable: per-message extraction outcome. No default — a message gets a
-- status only once extraction runs for it (NULL = idle/never-run shows no badge;
-- a DEFAULT 'pending' would otherwise strand every message at «анализ…»).
ALTER TABLE "message" ADD COLUMN "extraction_status" TEXT;
ALTER TABLE "message" ADD COLUMN "extraction_error" TEXT;
ALTER TABLE "message" ADD COLUMN "extracted_at" TIMESTAMP(3);

-- CreateIndex: status-filtered reads (failed/empty badges)
CREATE INDEX "message_conversation_id_extraction_status_idx" ON "message"("conversation_id", "extraction_status");

-- CreateTable: operator extraction hints consumed by the extractor agents
CREATE TABLE "extraction_hint" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "channel_id" TEXT,
    "conversation_id" TEXT,
    "target_field" TEXT,
    "guidance" TEXT NOT NULL,
    "example_input" TEXT,
    "example_output" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "extraction_hint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extraction_hint_scope_active_idx" ON "extraction_hint"("scope", "active");
CREATE INDEX "extraction_hint_channel_id_idx" ON "extraction_hint"("channel_id");
CREATE INDEX "extraction_hint_conversation_id_idx" ON "extraction_hint"("conversation_id");
