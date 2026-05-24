## 1. Schema & migration

- [x] 1.1 Add `openerVariant String?` to `model Message` in `packages/db/prisma/schema.prisma`.
- [x] 1.2 Add `@@index([conversationId, openerVariant])` to `model Message`.
- [x] 1.3 Create migration `packages/db/prisma/migrations/9e_opener_variant/migration.sql` — `ALTER TABLE "Message" ADD COLUMN "openerVariant" TEXT` + `CREATE INDEX "Message_conversationId_openerVariant_idx" ON "Message"("conversationId", "openerVariant")`.
- [x] 1.4 Generate the Prisma client locally (or note that CI's `pnpm prisma generate` covers it) so `Message.openerVariant` is part of the TS types used by services.

## 2. Composer changes — opening_composer

- [x] 2.1 Extend `openingComposerOutputSchema` in `packages/agents/src/agents/OpeningComposer.ts`: each variant gains an optional `variant_key: z.string().optional()` (raw LLM field) and an output `variantKey: z.string()` after the post-process.
- [x] 2.2 Implement the deterministic post-process in `openingComposer.run`: after `invokeJson`, walk variants in order, normalise `variant_key` (`trim`, cap 32 chars), dedupe within the response (`_2`/`_3` suffix), fall back to alphabetical `'A'`, `'B'`, … on missing/blank. Always emit `variantKey` (non-optional in the post-process output).
- [x] 2.3 Update the fallback prompt to mention `variant_key` as an optional hint (e.g. `'concise'` / `'value_prop'`) so operators tuning the prompt see it; the field stays optional so old prompts keep working.

## 3. Composer changes — agency_opening_composer

- [x] 3.1 Same schema extension as 2.1 on `agencyOpeningComposerOutputSchema` in `packages/agents/src/agents/AgencyOpeningComposer.ts`.
- [x] 3.2 Same post-process applied AFTER the existing `auto_send_eligible` guard map — shared helper `assignVariantKeys` keeps the two composers byte-for-byte aligned.
- [x] 3.3 Update fallback prompt analogously to 2.3.

## 4. Composer unit tests

- [x] 4.1 `packages/agents/src/__tests__/OpeningComposer.test.ts` (new): given an LLM mock returning three variants without `variant_key`, expect `['A','B','C']`.
- [x] 4.2 Given an LLM mock returning two variants with `variant_key: 'concise'` and `'value_prop'`, expect those keys preserved verbatim.
- [x] 4.3 Given three variants all with `variant_key: 'short'`, expect `'short'`, `'short_2'`, `'short_3'`.
- [x] 4.4 Given a variant with blank `variant_key: '   '`, expect alphabetical fallback. Plus edge cases: mix LLM+missing, length cap, direct helper unit tests.
- [x] 4.5 Analogous tests for `AgencyOpeningComposer` (default-A/B + LLM-supplied), the four pre-existing no-fabrication tests still pass.

## 5. Worker pass-through — Suggestion.meta

- [x] 5.1 `apps/workers/src/queues/campaign-dispatcher.ts`: in the `for (const v of opener.variants)` loop, populate `Suggestion.meta = { openerVariant: v.variantKey }` on create. Update the local `OpenerOut` interface to include `variantKey: string` per variant.
- [x] 5.2 `apps/workers/src/queues/agent-run.ts`: same change in `handleOutreachFirstMessage`'s opener-suggestion loop.
- [x] 5.3 Ensure `OpenerOut` typing in both files reflects the new `variantKey` field.

## 6. Worker pass-through — Message.openerVariant (auto-approve)

- [x] 6.1 `apps/workers/src/services/auto-approve.ts`: read `Suggestion.{agentName, meta}` once before the `$transaction`, gate via `extractOpenerVariant` helper (agentName ∈ openers + non-empty string + ≤32 chars), pass `openerVariant` into `Message.create` only when the helper returned a value.
- [x] 6.2 Unit test covering opening_composer + agency_opening_composer happy paths: `prisma.message.create` called with `openerVariant: 'B' / 'with_brand'`.
- [x] 6.3 Unit tests covering non-opener reply, missing meta, corrupted-meta (non-string), too-long-string: `openerVariant` is undefined on the created message. Plus direct `extractOpenerVariant` unit tests.

## 7. API pass-through — Message.openerVariant (operator-approve)

- [x] 7.1 `apps/api/src/services/conversations.ts`: in `approveSuggestion`, read `s.{agentName, meta}` and forward `openerVariant` via the shared helper.
- [x] 7.2 In `sendOperatorMessage`, accept an optional `openerVariant?: string` argument and persist it on `Message.create`. Left null when not provided.
- [x] 7.3 Defensive guard centralised in shared `extractOpenerVariant` (gates on agentName + string + length ≤ 32). For other agents the field stays null.

## 8. Shared schemas

- [x] 8.1 Create `packages/shared/src/schemas/opener-stats.ts` with `OpenerStatsQueryZ`, `OpenerStatsRowZ`, `OpenerStatsZ` + type exports.
- [x] 8.2 Re-export via `packages/shared/src/schemas/index.ts` (already wildcarded from root index).

## 9. API service — opener-stats

- [x] 9.1 New file `apps/api/src/services/opener-stats.ts` with `openerStatsService.get(campaignId, withinHours)`.
- [x] 9.2 Implementation: campaign existence check, then two Prisma findMany (openers + inbounds in the relevant window) joined in-memory by conversationId. No `$queryRaw` — no precedent in this codebase, and the dataset is small.
- [x] 9.3 Defensive `replyRate` clamp to `[0, 1]`. Sort by `variantKey` ascending.
- [x] 9.4 Return `[]` if no opener-attributed messages exist for the campaign.

## 10. API route

- [x] 10.1 `apps/api/src/routes/campaigns.ts`: add `GET /campaigns/:id/opener-stats` (admin/operator/viewer, `OpenerStatsQueryZ` for query parsing).

## 11. Service unit tests

- [x] 11.1 `apps/api/src/services/__tests__/opener-stats.test.ts`: covers happy path, reply-outside-window, edge-of-window, inbound-before-opener, sort order, replyRate clamp, mixed mix-and-match, no-data, campaign-not-found.
- [x] 11.2 Uses the same Prisma-mock pattern as `discovery-batch.test.ts`.

## 12. Documentation

- [x] 12.1 `CHANGELOG.md` — under `## Unreleased → ### Added`: A/B opener variants entry with composer + Message + endpoint summary.

## 13. Regression suite

- [x] 13.1 `pnpm typecheck` green (17 tasks).
- [x] 13.2 `pnpm lint` green (10 tasks).
- [x] 13.3 `pnpm test` green (~430 tests, 1 skipped — added composer/schema/conversation regression tests after codex rounds 1 and 2).
- [x] 13.4 Sanity: `openspec validate ab-opener-variants --changes` reports valid.

## 14. Review and archive

- [x] 14.1 Codex review via `node "/root/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" task --wait --fresh ...`. Three rounds: R1 → three blockers (schema-stripping, generic sendOperatorMessage path missing meta lookup, agency runs persisting wrong agentName). R2 → two new blockers (conv-scope bypass, text-cap regression). R3 → `Verdict: approve`.
- [x] 14.2 `openspec archive ab-opener-variants` — see step below.
