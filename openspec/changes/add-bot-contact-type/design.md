## Context

The `Contact` model carries a `ContactType` enum with 7 values (`tg_username`, `tg_phone`, `tg_link`, `email`, `website`, `web_form`, `other`) defined in four synchronized places: the Prisma enum, `packages/shared/src/types/index.ts`, the `ContactTypeZ` zod enum in `packages/shared/src/schemas/contact.ts`, and the web `ContactType` union. Reachability is derived from type in `apps/api/src/services/contacts.ts#reachabilityForType` and the `contact-extract` worker, and the `campaign-dispatcher` only auto-dispatches contacts with `reachability = 'reachable_tg'`.

Separately, an orthogonal `RoleGuess` enum already contains a `bot` value. Today a Telegram bot handle (`@..._bot`) is treated as `type = tg_username` with `roleGuess = bot`, and the `ContactExtractor` LLM prompt is told to *reject* bots "когда контекст НЕ говорит о приёме рекламы" — so an ad-intake bot like `@hadeout_bot` that a blogger publishes as their only ad contact is at best mislabeled and at worst dropped.

Per project safety rules, an explicitly-published ad/business contact is in-scope for `agency_sourcing`. An ad bot named in "по рекламе — @hadeout_bot" is exactly that. We need to model it as a first-class contact type.

## Goals / Non-Goals

**Goals:**
- Represent an advertising/intake Telegram bot as a distinct `bot` contact type, end to end (DB → shared contracts → extraction → API → UI).
- Stop dropping `*_bot` handles when context shows they are the published ad contact; classify them as `bot`.
- Make `bot` contacts visible and manually reachable by operators, without sweeping them into automated outreach.
- Keep `ContactType.bot` (the channel) and `RoleGuess.bot` (the actor) coherent and non-contradictory.

**Non-Goals:**
- No automated bot-conversation handling (no `/start` flow automation, no menu/button navigation). Reaching a bot stays an operator action.
- No new feature flag — this is a structural enrichment of an existing model, not a gated rollout surface.
- No backfill/reclassification of historical `tg_username` contacts that are actually bots (can be a follow-up; called out in Open Questions).

## Decisions

### Decision 1: `bot` is a new `ContactType`, not a reuse of `RoleGuess.bot`
The two model different axes: **type** = *how* you reach the contact (the channel/protocol), **role** = *who/what* is behind it. An ad bot is a channel you message via Telegram; a human ad-manager handle is `type=tg_username, role=ad_manager`. An ad bot becomes `type=bot, role=ad_manager` (it is the ad contact) — role and type stay independent. We do **not** collapse role into type.
- *Alternative considered:* keep `type=tg_username` and rely on `roleGuess=bot`. Rejected — operators can't filter/treat bots as a class, reachability/dispatch can't branch cleanly, and the existing extractor still rejects them.

### Decision 2: Reachability `reachable_tg`, but excluded from auto-dispatch
A Telegram bot can be DM'd, so `reachabilityForType('bot') = 'reachable_tg'` keeps it surfaced as TG-reachable. However, `campaign-dispatcher` SHALL exclude `type = 'bot'` from automated selection even though it is `reachable_tg`, because our human-framed agency opener does not fit a bot's `/start`/menu interaction model and auto-sending risks a dead/confusing exchange. Bot contacts therefore land in the operator's manual/assisted surface.
- *Implementation note:* the dispatcher `where` adds `type: { not: 'bot' }` (or an explicit `type: { in: [...] }` allowlist) alongside the existing `reachability: 'reachable_tg'` filter, so the exclusion is explicit and testable.
- *Alternative considered:* make `bot` `reachability = 'manual'`. Rejected — that misrepresents it as not-TG-reachable and would hide it from TG-oriented operator tooling; the dispatcher-level exclusion is the more precise lever.

### Decision 3: Extractor classifies `*_bot` as `bot` only with ad/business context
`ContactExtractor` (regex candidate schema, LLM output schema, and the Russian system prompt) gains `bot` as an allowed type. Rule: a handle matching the bot-suffix pattern (`_bot`/`bot`) becomes `type = bot` **iff** the surrounding context indicates an advertising/business intake purpose ("по рекламе", "реклама", "сотрудничество", "прайс в бот", media kit, заявки). Without such context, the existing rejection of bot handles is preserved — we do not start ingesting arbitrary bots. The regex pass already detects the `_bot` suffix for role inference; we extend it to emit a `bot` type candidate, with the LLM confirming/denying based on context (consistent with how `ad_manager` is confirmed today).

### Decision 4: Manual create/auto-detect support
`detectContactType()` gains a branch: a `*_bot` handle (after `@`/`t.me/` normalization) → `bot`. Manual operators can also pick `bot` explicitly in the create dialog / edit drawer. Normalized `value` follows the same `@handle` normalization as `tg_username`.

### Decision 5: Enum value added in all four definitions + migration
Add `bot` to: Prisma `enum ContactType`, shared `ContactType` union, `ContactTypeZ` zod enum, web `ContactType` union, and the `mapContactType()` switch in the worker. A Prisma migration adds the Postgres enum label. The `@@unique([channelId, type, value])` constraint means a handle already stored as `tg_username` and the same handle as `bot` are distinct rows — acceptable; no dedupe collision.

## Risks / Trade-offs

- **[Postgres enum migration is additive-only / forward-only]** → Adding an enum label is safe and non-destructive; ensure the migration uses `ALTER TYPE ... ADD VALUE` (Prisma generates this). No rollback data loss since no rows use the new value at deploy time.
- **[Extractor over-classifies humans as bots or vice-versa]** → Gate strictly on the `_bot` suffix pattern AND ad/business context; LLM step remains the arbiter for ambiguous cases and low-confidence results are flagged, not dropped (existing behavior). Add unit tests for `@hadeout_bot`-style positives and `@somebot`-no-context negatives.
- **[Operator accidentally auto-sends a human opener to a bot]** → Dispatcher-level exclusion of `type='bot'` prevents automated sends; manual sends remain an explicit operator choice.
- **[Drift between the four enum definitions]** → Tasks enumerate every site; a typecheck (`noUncheckedIndexedAccess`, exhaustive switch in `mapContactType`) catches a missed location at build time.
- **[Existing mislabeled bots stay as `tg_username`]** → Accepted for this change; backfill is out of scope (Open Questions).

## Migration Plan

1. Add `bot` to the Prisma `ContactType` enum; `pnpm db:migrate` to generate the additive `ALTER TYPE` migration.
2. Update shared types/zod, web types, worker `mapContactType`, extractor schemas+prompt, `detectContactType`, `reachabilityForType`, dispatcher filter, UI option lists + icon.
3. Deploy migration first (additive, backward-compatible), then app code. No data backfill required.
4. **Rollback:** revert app code; the unused enum label can remain (Postgres enum labels cannot be trivially dropped, and an unused label is harmless).

## Open Questions

- **Backfill?** Should we reclassify existing `tg_username` contacts whose handle ends in `_bot` and whose label/context indicates ads into `bot`? Proposed: defer to a follow-up one-off script; out of scope here.
- **Icon choice** for `bot` in the UI (e.g. a `bot`/`cpu`/`message-square` glyph) — pick from the existing `IconName` set during implementation; no behavioral impact.
