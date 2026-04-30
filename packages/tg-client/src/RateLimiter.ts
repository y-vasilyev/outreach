import type {
  RateConsumeResult,
  RateKind,
  RateLimits,
  RateState,
} from './types.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Returns the UTC midnight timestamp (ms) for the day containing `ts`.
 */
function utcMidnight(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Per-account rolling-window rate limiter. Not persisted — counts live in
 * memory and reset on process restart. That's fine: limits are guard-rails,
 * the durable state lives in `tg_op_log` / `tg_account.cooldown_until`.
 */
export class RateLimiter {
  private limits: RateLimits;

  // Sliding-minute window: timestamps of recent message sends.
  private readonly msgTimestamps: number[] = [];

  // Daily counters reset at UTC midnight.
  private dayBucket: number;
  private msgToday = 0;
  private newContactsToday = 0;

  constructor(limits: RateLimits, now: number = Date.now()) {
    this.limits = { ...limits };
    this.dayBucket = utcMidnight(now);
  }

  setLimits(limits: Partial<RateLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  getLimits(): RateLimits {
    return { ...this.limits };
  }

  private rollover(now: number): void {
    // Drop minute-old timestamps.
    const cutoff = now - MINUTE_MS;
    while (this.msgTimestamps.length > 0) {
      const head = this.msgTimestamps[0];
      if (head !== undefined && head < cutoff) {
        this.msgTimestamps.shift();
      } else {
        break;
      }
    }
    // Roll over day bucket.
    const todayBucket = utcMidnight(now);
    if (todayBucket !== this.dayBucket) {
      this.dayBucket = todayBucket;
      this.msgToday = 0;
      this.newContactsToday = 0;
    }
  }

  /**
   * Attempts to consume a unit of the requested rate kind.
   * On success counters are incremented; on failure they are left untouched
   * and a `retryAfterMs` is returned (best-effort estimate, never negative).
   */
  async tryConsume(
    kind: RateKind,
    now: number = Date.now(),
  ): Promise<RateConsumeResult> {
    this.rollover(now);

    if (kind === 'msg') {
      if (this.msgTimestamps.length >= this.limits.msgPerMinute) {
        const oldest = this.msgTimestamps[0] ?? now;
        const retryAfterMs = Math.max(0, oldest + MINUTE_MS - now);
        return { ok: false, retryAfterMs };
      }
      if (this.msgToday >= this.limits.msgPerDay) {
        const retryAfterMs = Math.max(0, this.dayBucket + DAY_MS - now);
        return { ok: false, retryAfterMs };
      }
      this.msgTimestamps.push(now);
      this.msgToday += 1;
      return { ok: true };
    }

    // newContact
    if (this.newContactsToday >= this.limits.newContactsPerDay) {
      const retryAfterMs = Math.max(0, this.dayBucket + DAY_MS - now);
      return { ok: false, retryAfterMs };
    }
    this.newContactsToday += 1;
    return { ok: true };
  }

  getState(now: number = Date.now()): RateState {
    this.rollover(now);
    return {
      msgInMinute: this.msgTimestamps.length,
      msgInDay: this.msgToday,
      newContactsInDay: this.newContactsToday,
    };
  }
}
