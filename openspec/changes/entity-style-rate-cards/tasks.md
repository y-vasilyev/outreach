## 1. Shared Schemas And Registry

- [x] 1.1 Add `PlacementOffer`, `PlacementAttribute`, `PlacementAttributeRegistryEntry`, and `PlacementAttributeProposal` zod schemas/types in `packages/shared`.
- [x] 1.2 Seed the active placement attribute registry with v1 attributes: `platform`, `kind`, `duration`, `delete_policy`, `includes`, `tax`, `price`, `currency`, and `notes`.
- [x] 1.3 Add helpers to validate offer attributes, derive legacy rate-card format keys, and convert placement offers to legacy `RateCard[]`.
- [x] 1.4 Add shared unit tests for registry validation, unknown-attribute proposal handling, and legacy rate-card derivation.

## 2. Extraction And Persistence

- [x] 2.1 Extend `RateCardExtractor` output schema and prompt to emit `placement_offers[]` plus `attribute_proposals[]` while keeping legacy `data_points[]` during rollout.
- [x] 2.2 Convert deterministic rate parsing helpers into placement-offer builders for structured table quotes and inline quote text.
- [x] 2.3 Update `apps/workers/src/queues/profile-extract.ts` to persist structured placement offers with source message/run provenance.
- [x] 2.4 Add worker/agent regression tests for inline post durations, offsite reviews, tax attributes, ambiguous package offers, and inactive attribute proposals.

## 3. Profile Roll-Up, API, And UI

- [x] 3.1 Extend blogger profile roll-up to compute `placementOffers`, derive compatibility `rateCards`/`formats`, and classify freshness from structured offers.
- [x] 3.2 Update `bloggerProfilesService` list/detail responses to include structured offers while preserving existing response fields.
- [x] 3.3 Render placement offers in the blogger catalog/profile UI as structured terms, with source-message links and legacy fallback.
- [x] 3.4 Add API and web tests proving structured offers do not collapse day/month post prices and unknown attributes remain review-only.

## 4. Planner And Attribute Review

- [x] 4.1 Feed known placement offers and required active attributes into `DataCollectionPlanner`.
- [x] 4.2 Update planner logic and prompts to ask focused follow-ups for missing offer attributes such as deletion policy, duration, tax, or included deliverables.
- [x] 4.3 Add an operator/admin review surface or service endpoint for approving/rejecting `PlacementAttributeProposal` records.
- [x] 4.4 Add tests that approved attributes become active and inactive proposals do not complete data-collection targets.

## 5. Matching And Rollout

- [x] 5.1 Update deterministic matching to prefer structured placement attributes when present and fall back to legacy `rateCards` otherwise.
- [x] 5.2 Update LLM reranker candidate summaries/rationales to include structured placement terms used for scoring.
- [x] 5.3 Add a `structured_placement_offers` feature flag and dual-write rollout path with a legacy-only fallback.
- [x] 5.4 Verify `pnpm typecheck && pnpm test` plus targeted staging checks on real agency conversations with inline quotes, media-kit tables, and package offers. _(Automated `pnpm typecheck && pnpm lint && pnpm test` all green; staging checks on real conversations remain a manual step to run after deploy with the flag enabled.)_
