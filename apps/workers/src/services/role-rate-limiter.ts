import { logger } from '../logger.js';

/**
 * Per-account sliding-window rate limiter, keyed by the *role context* of the
 * call (not the account's stored role). Two configurable caps live here:
 *
 *   - `TG_PARSER_RPM` — max MTProto calls per minute via a parser account
 *     (channel-scrape → TelegramAdapter.scrapeChannel etc.)
 *   - `TG_OUTREACH_RPM` — max MTProto calls per minute via an outreach
 *     account (tg-send → sendMessage; markRead; conversation-sync history)
 *
 * Both env vars are OPTIONAL. Unset → unlimited (the historical default).
 * Once set, the limiter is the worker-side throttle that keeps a single
 * account from hammering TG fast enough to trip FloodWait, BEFORE we ever
 * hit the upstream's protection.
 *
 * Implementation: per-account ring of timestamps. acquire() trims the window
 * and either appends + returns ok=true, or returns ok=false with the ms until
 * the oldest in-window slot expires.
 *
 * In-process only — fine for a single worker replica. When we scale workers
 * horizontally this needs to move behind a Redis counter (token bucket).
 */
const WINDOW_MS = 60_000;

function readEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

class RoleRateLimiter {
  private readonly slots = new Map<string, number[]>();
  private parserCap: number | null = null;
  private outreachCap: number | null = null;
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.parserCap = readEnvInt('TG_PARSER_RPM');
    this.outreachCap = readEnvInt('TG_OUTREACH_RPM');
    this.loaded = true;
    logger.info(
      { parserRpm: this.parserCap ?? 'unlimited', outreachRpm: this.outreachCap ?? 'unlimited' },
      'role-rate-limiter: configured',
    );
  }

  private cap(role: 'parser' | 'outreach'): number | null {
    this.load();
    return role === 'parser' ? this.parserCap : this.outreachCap;
  }

  /**
   * Trim the window in place and return the resulting list (same array
   * reference so callers can push without re-storing).
   */
  private trim(accountId: string, now: number): number[] {
    let arr = this.slots.get(accountId);
    if (!arr) {
      arr = [];
      this.slots.set(accountId, arr);
    }
    const cutoff = now - WINDOW_MS;
    // arr is monotonically non-decreasing — find first index >= cutoff.
    let i = 0;
    while (i < arr.length && arr[i]! < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr;
  }

  /**
   * Try to reserve a slot. Returns ok=true and consumes when below cap (or
   * cap is unset). Returns ok=false with retryAfterMs (>0) when at cap.
   */
  acquire(
    accountId: string,
    role: 'parser' | 'outreach',
  ): { ok: true } | { ok: false; retryAfterMs: number } {
    const cap = this.cap(role);
    if (cap === null) return { ok: true };
    const now = Date.now();
    const arr = this.trim(accountId, now);
    if (arr.length < cap) {
      arr.push(now);
      return { ok: true };
    }
    const oldest = arr[0]!;
    const retryAfterMs = Math.max(1, oldest + WINDOW_MS - now);
    return { ok: false, retryAfterMs };
  }

  /**
   * Inspect the next free slot WITHOUT consuming. Used by the channel-scrape
   * picker to choose the account that's free soonest among multiple candidates.
   * Returns 0 when free now, >0 when ms-until-free.
   */
  nextFreeInMs(accountId: string, role: 'parser' | 'outreach'): number {
    const cap = this.cap(role);
    if (cap === null) return 0;
    const now = Date.now();
    const arr = this.trim(accountId, now);
    if (arr.length < cap) return 0;
    const oldest = arr[0]!;
    return Math.max(0, oldest + WINDOW_MS - now);
  }

  /** For tests / clear-cooldown ergonomics. */
  reset(accountId: string): void {
    this.slots.delete(accountId);
  }
}

export const roleRateLimiter = new RoleRateLimiter();
