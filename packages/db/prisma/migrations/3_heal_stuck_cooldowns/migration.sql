-- Unstick tg_account rows that the FloodWait hook left in `cooldown` status
-- without a `cooldown_until` timestamp. Before this migration the hook only
-- called markStatus('cooldown') and never setCooldownUntil(...), so once an
-- account hit FLOOD_WAIT it stayed out of the parser/outreach pool forever
-- (no scheduled reset existed either). This one-shot heal pulls every such
-- row back to `idle`; the new healer loop + fixed hook prevent the leak
-- going forward.
UPDATE "tg_account"
SET "status" = 'idle'
WHERE "status" = 'cooldown'
  AND ("cooldown_until" IS NULL OR "cooldown_until" <= NOW());
