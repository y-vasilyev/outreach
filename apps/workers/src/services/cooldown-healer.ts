import { getPrisma } from '@nosquare/db';
import { logger } from '../logger.js';

/**
 * Periodic worker-side reconciler that flips `tg_account.status` from
 * `cooldown` back to `active` once `cooldown_until` is in the past. Closes
 * the gap left by the FloodWait hook in SessionManager, which sets the
 * timestamp but has no scheduler to undo the status flip.
 *
 * Without this loop, an account that hit a single short FloodWait gets
 * permanently kicked out of the pool — the channel-scrape and tg-listen
 * pickers filter on healthy statuses, so a stuck `cooldown` row never
 * surfaces again. Visible symptom (with 200 accounts loaded): the pool
 * silently shrinks one row at a time.
 */
const HEAL_INTERVAL_MS = 30_000;

export async function healExpiredCooldownAccounts(): Promise<number> {
  const result = await getPrisma().tgAccount.updateMany({
    where: {
      status: 'cooldown',
      OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: new Date() } }],
    },
    data: { status: 'active' },
  });
  return result.count;
}

export function startCooldownHealer(): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const healed = await healExpiredCooldownAccounts();
      if (healed > 0) {
        logger.info({ healed }, 'cooldown-healer: returned accounts to active');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cooldown-healer: tick failed');
    }
  };
  // Don't await the first tick — boot stays fast; it'll run on the interval.
  const timer = setInterval(() => {
    void tick();
  }, HEAL_INTERVAL_MS);
  // Initial tick after a short delay so we don't compete with DB connection pool warmup.
  setTimeout(() => void tick(), 5_000);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
