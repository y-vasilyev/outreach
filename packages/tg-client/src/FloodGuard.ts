/**
 * Centralized FloodWait registry. When GramJS throws `FLOOD_WAIT_X`,
 * the wrapper records a cooldown here so other call-sites for the
 * same account can short-circuit before hitting the wire again.
 *
 * State is in-memory; durable state lives in `tg_account.cooldown_until`.
 */
export class FloodGuard {
  /** tgAccountId -> epoch ms until which sends are blocked. */
  private readonly cooldowns = new Map<string, number>();

  isCoolingDown(accountId: string, now: number = Date.now()): boolean {
    const until = this.cooldowns.get(accountId);
    if (until === undefined) return false;
    if (until <= now) {
      this.cooldowns.delete(accountId);
      return false;
    }
    return true;
  }

  cooldownUntil(accountId: string): number | null {
    const until = this.cooldowns.get(accountId);
    return until ?? null;
  }

  /**
   * Records a FloodWait for `seconds`. The optional hook is invoked once
   * with the absolute `until` Date (useful to update the DB / pause queues).
   * Hook errors are swallowed to keep the guard ergonomic at call-sites.
   */
  recordFloodWait(
    accountId: string,
    seconds: number,
    hook?: (until: Date) => void | Promise<void>,
  ): void {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const until = Date.now() + safeSeconds * 1000;
    this.cooldowns.set(accountId, until);
    if (hook) {
      try {
        const ret = hook(new Date(until));
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>).catch(() => {
            /* swallow — best-effort hook */
          });
        }
      } catch {
        /* swallow — best-effort hook */
      }
    }
  }

  clear(accountId: string): void {
    this.cooldowns.delete(accountId);
  }
}

/** Process-wide singleton — there is no reason to have more than one. */
export const floodGuard = new FloodGuard();
