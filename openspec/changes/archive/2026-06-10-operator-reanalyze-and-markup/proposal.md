## Why

When extraction misses or garbles a blogger's reply, the operator is stuck: there is no way to see WHICH reply failed, no way to re-run analysis after a fix, no way to correct a wrong/missing value, and no way to teach the agents a blogger's nuance so they get it right next time. The catalog silently stays wrong. This is the operator's most-felt gap ("в каталог добавляется нестабильно … не могу создать разметку"). This change makes extraction observable, re-runnable, correctable, and teachable.

## What Changes

- **Per-message extraction status.** `Message` gains `extractionStatus` (`pending|ok|empty|no_signal|failed`), `extractionError`, `extractedAt`. The profile-extract worker stamps it on every inbound it processes (incl. pre-gate skips and double-failures), so the operator can see exactly which reply produced data, produced nothing, or failed.
- **Operator re-run with supersede.** A new `POST /conversations/:id/messages/:mid/reanalyze` enqueues profile-extract for that message with `supersede: true`. Supersede DELETES the prior `(profileId, sourceMessageId)` data points / placement offers / attribute proposals before re-extracting, so a re-run after a prompt fix or a new markup REPLACES stale rows instead of being skipped by idempotency (today's dedupe makes a re-run a no-op).
- **Operator correction write-path.** `POST /blogger-profiles/:id/data-points` writes an operator-origin data point (`extractedBy='operator'`, `confidence=1.0`) that the deterministic roll-up then prefers (highest confidence wins) — so an operator can fix a wrong reach or add a missing price. `DELETE /blogger-profiles/:id/data-points/:dpid` removes a wrong machine-extracted point. The profile re-rolls after either.
- **Extraction markup/hints that agents consume.** A new `extraction_hint` table holds operator guidance scoped `global|channel|conversation`, optionally targeting a field, with free-text guidance and optional few-shot `exampleInput`/`exampleOutput`. The profile-extract worker loads the applicable hints and passes them to the extractor agents (`operator_hints` input), which render them into the prompt — so next time the agent handles the nuance (e.g. «у этого блогера МАХ — это мессенджер MAX, не "максимум"»). CRUD endpoints + an admin/operator surface.
- **UI.** Per-message extraction-status badge + a «Переанализировать» button in the inbox; an inline correct/delete control on the profile data-points table; a hint-creation form (from a failed message or the profile).

## Capabilities

### New Capabilities

- `operator-reanalysis`: per-message extraction status + an operator-triggered re-run that supersedes prior rows.
- `extraction-markup`: operator corrections to profile data points + operator hints that the extractor agents consume at run time.

### Modified Capabilities

- `agency-sourcing-pipeline`: the worker stamps per-message extraction status, honors `supersede`, and feeds operator hints into extraction.
- `blogger-commercial-profile`: the profile read exposes per-point origin (`operator` vs agent) and supports operator-written/【deleted】points; roll-up prefers operator points.

## Impact

- **DB migration `9c_operator_reanalyze_and_markup`**: add `message.extraction_status|extraction_error|extracted_at`; create `extraction_hint` table.
- **packages/db**: schema + migration; `ExtractionHint` model.
- **packages/shared**: zod schemas for reanalyze request, FIELD-AWARE operator data-point write/delete, `ExtractionHint`, the extractor `operator_hints` input field, and a `message.extraction_status.changed` realtime event; roll-up already prefers higher confidence (operator=1.0) — no change beyond exposing origin.
- **packages/agents**: `RateCardExtractor`/`AudienceStatsExtractor` accept `operator_hints` and render them into the prompt (still tolerant-validated).
- **apps/workers**: `profile-extract` stamps status, implements supersede (delete-before-write), loads + passes hints.
- **apps/api**: reanalyze route; data-point write/delete routes; extraction-hint CRUD; message read includes extraction status; behind the existing `agency_sourcing` feature.
- **apps/web**: inbox per-message status badge + reanalyze button; profile data-point correct/delete; hint form.
- **Compatibility**: all additive. Existing extraction path unchanged when no operator action/hint exists; default extraction status `pending`→stamped. No change to non-agency flows.
