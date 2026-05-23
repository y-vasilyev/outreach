# chat-autonomous-modes — Deploy Runbook

This change ships in one release. Steps below apply at deploy time.

## 1. Drain the `agent-run` queue

The data migration in step 2 rewrites `Conversation.mode` and `Campaign.defaultMode`. In-flight `agent-run` jobs read those columns inside their handler — if a job runs at the same time as the UPDATE, it may take a decision against a stale mode value.

```sh
# Pause workers
pm2 stop nosquare-workers   # or your equivalent
# Wait for the BullMQ queue to be empty:
redis-cli -n 0 LLEN bull:agent-run:wait
redis-cli -n 0 LLEN bull:agent-run:active
# Both should be 0 before continuing.
```

If you can't pause workers, the worst-case is a single conversation gets a stale `auto`-mode decision on the first inbound after deploy. Hysteresis covers it; there is no data corruption risk.

## 2. Apply migrations

```sh
pnpm db:migrate:deploy
```

Migration `4_chat_autonomous_modes` is additive:

- adds `ConversationMode.semi_auto` enum value (legacy `auto` retained for one release),
- adds `Campaign.ajtbd` (JSONB, nullable; backfilled inline from goalText/valueProp for existing rows),
- adds `Conversation.qualityDecision` (JSONB, nullable),
- adds `Conversation.lastSyncedAt` (TIMESTAMPTZ, nullable),
- updates rows with legacy `auto` mode to `semi_auto`.

The migration is wrapped in a transaction except for the `ALTER TYPE … ADD VALUE` statement (Postgres requirement). Re-running is idempotent (`IF NOT EXISTS` guards on column adds).

## 3. Reseed agents

```sh
pnpm db:seed
```

Adds the `goal_fit_evaluator` `agent_config` row at v1 with default thresholds. Existing agents whose prompts were extended (reply_composer, handoff_decider, safety_filter) keep their UI-edited prompts: the seed runner only upgrades when `seed.version > db.version`, and we did NOT bump those agents' versions in this change (their input schema is backwards-compatible — old prompts still work, new prompts get the AJTBD context only after operators edit them).

## 4. Restart workers and API

```sh
pm2 start nosquare-workers
pm2 restart nosquare-api
```

## 5. Sanity checks

- Open a conversation in the inbox → no errors in API logs.
- Find a conversation that had `auto` before the deploy → mode shows as `semi_auto` in the header.
- Check the conversation pick logs: `event: conversation_sync.completed_after_budget` should be rare; `event: tg.message.first_persist_via_sync` should appear only when the push path was unhealthy.
- For a campaign in `auto` defaultMode → next inbound generates a `quality.gate` event in operator realtime.

## 6. Future cleanup (not required for this release)

- **Redefine `auto` enum value semantics in DB**: today's `auto` enum value still exists in Postgres and is now interpreted as the new strict mode. If we ever want to clean the DB enum (`auto`, `semi_auto`, `assisted`, `manual`), Postgres requires a multi-step dance (drop value, recreate). See `design.md` Decision 1. Defer until after at least one release confirms the new modes work in production.
- **Remove `LEGACY_AUTO_MEANS_SEMI_AUTO` env shim**: it's off by default in this release. Once external integrations (if any) catch up, remove the normalization in `apps/api/src/routes/conversations.ts`.
