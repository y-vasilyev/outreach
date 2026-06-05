## Why

Some bloggers publish **only an advertising bot** as their business contact — e.g. "по рекламе писать в @hadeout_bot". This is an explicitly-published ad/business contact, but today the system has no way to represent it: handles ending in `_bot` are either coerced into `tg_username` or rejected by the `ContactExtractor` (whose prompt drops bots unless context proves they accept ads). As a result a legitimate, publicly-stated ad intake channel is lost, and operators have no typed surface to reach it. We need a first-class `bot` contact type so these ad-intake bots are captured, displayed, and reachable through the normal flow.

## What Changes

- Add a new `bot` value to the `ContactType` enum across the stack (Prisma enum, shared types, shared zod schema, web types).
- `ContactExtractor` SHALL classify a `*_bot` Telegram handle as a `bot` **contact type** (not rejected) when the surrounding context indicates it is an advertising/business intake channel ("по рекламе", "реклама в бот", media kit, etc.). When a `_bot` handle has no ad/business context, it continues to be rejected as before (kept out of sourcing).
- The manual `detectContactType()` path and the create/edit UI SHALL support choosing/auto-detecting the `bot` type.
- Reachability: a `bot` contact is `reachable_tg` (a Telegram bot can be DM'd), but is **not** auto-send eligible for `agency_sourcing` campaigns by default — bots typically require a `/start` / menu flow rather than a human-framed opener, so `bot` contacts route to the operator (manual/assisted) instead of automated dispatch.
- UI: add `bot` to the type filter, create dialog, edit drawer, and a distinct icon/badge so operators can see at a glance that a contact is an ad bot.

This is **not** a database-destructive change: it is an additive enum value plus extraction/UI wiring. (Adding a Postgres enum value requires a migration.)

## Capabilities

### New Capabilities
- `bot-contact-type`: Modeling, extraction, reachability, and operator surfacing of the `bot` contact type (advertising/intake Telegram bots) as an explicitly-published business contact, including its exclusion from automated agency-sourcing dispatch.

### Modified Capabilities
<!-- No existing spec currently states requirements for the contact-typing / reachability model; all new behavior lives in the new capability above. -->

## Impact

- **Schema (migration required)**: `packages/db/prisma/schema.prisma` — add `bot` to `enum ContactType` → `pnpm db:migrate`.
- **Shared contracts**: `packages/shared/src/types/index.ts`, `packages/shared/src/schemas/contact.ts`.
- **Extraction**: `packages/agents/src/agents/ContactExtractor.ts` (candidate + LLM output schemas, system prompt), `packages/agents/src/regex.ts` (role/type hint), `apps/workers/src/queues/contact-extract.ts` (`mapContactType`, persistence reachability).
- **API**: `apps/api/src/services/contacts.ts` (`detectContactType`, `reachabilityForType`), `apps/api/src/routes/contacts.ts` (validation flows through shared zod).
- **Dispatch / send**: `apps/workers/src/queues/campaign-dispatcher.ts` (exclude `bot` from auto-dispatch even though `reachable_tg`), `apps/workers/src/queues/tg-send.ts` (bot resolution path, if reached manually).
- **Web UI**: `apps/web/src/features/contacts/types.ts`, `ContactsPage.vue`, `ContactCreateDialog.vue`, `ContactEditDrawer.vue` (type options + icon).
- **Docs**: `DESIGN.md` (Contact model / contact types), `CHANGELOG.md`.
- Relates to existing `RoleGuess.bot` (a *role*, orthogonal to type) — design must reconcile the two so they don't conflict.
