-- 9e_opener_variant
--
-- A/B opener variants (ab-opener-variants change). Adds a nullable
-- `openerVariant` column to `Message` so we can attribute outbound
-- opener sends to a stable variantKey emitted by `opening_composer` /
-- `agency_opening_composer`. The column is populated by both auto-send
-- (`tryAutoApprove`) and operator-approve (`approveSuggestion`) paths
-- when the source `Suggestion.agentName` is an opener; null elsewhere
-- (replies, ad-hoc operator messages, inbound).
--
-- The new (conversationId, openerVariant) index supports the per-variant
-- aggregates served by `GET /campaigns/:id/opener-stats`. See openspec
-- change `ab-opener-variants`.

ALTER TABLE "Message" ADD COLUMN "openerVariant" TEXT;

CREATE INDEX "Message_conversationId_openerVariant_idx" ON "Message"("conversationId", "openerVariant");
