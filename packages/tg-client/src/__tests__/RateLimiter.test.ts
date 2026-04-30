import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../RateLimiter.js';

const T0 = Date.UTC(2025, 0, 15, 10, 0, 0); // 2025-01-15 10:00 UTC

describe('RateLimiter', () => {
  it('allows up to msgPerMinute within a 60s window, then blocks with retryAfterMs', async () => {
    const rl = new RateLimiter(
      { msgPerMinute: 3, msgPerDay: 100, newContactsPerDay: 10 },
      T0,
    );

    expect((await rl.tryConsume('msg', T0)).ok).toBe(true);
    expect((await rl.tryConsume('msg', T0 + 1_000)).ok).toBe(true);
    expect((await rl.tryConsume('msg', T0 + 2_000)).ok).toBe(true);

    const blocked = await rl.tryConsume('msg', T0 + 3_000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      // Oldest at T0, retry available at T0+60_000 → 57s left.
      expect(blocked.retryAfterMs).toBe(57_000);
    }
  });

  it('frees a slot once the oldest msg ages past 60s', async () => {
    const rl = new RateLimiter(
      { msgPerMinute: 2, msgPerDay: 100, newContactsPerDay: 10 },
      T0,
    );
    await rl.tryConsume('msg', T0);
    await rl.tryConsume('msg', T0 + 5_000);

    const stillBlocked = await rl.tryConsume('msg', T0 + 30_000);
    expect(stillBlocked.ok).toBe(false);

    const freed = await rl.tryConsume('msg', T0 + 60_001);
    expect(freed.ok).toBe(true);
  });

  it('enforces msgPerDay across the UTC day', async () => {
    const rl = new RateLimiter(
      { msgPerMinute: 100, msgPerDay: 2, newContactsPerDay: 10 },
      T0,
    );
    expect((await rl.tryConsume('msg', T0)).ok).toBe(true);
    expect((await rl.tryConsume('msg', T0 + 60_001)).ok).toBe(true);
    const blocked = await rl.tryConsume('msg', T0 + 120_001);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      // retry at next UTC midnight (2025-01-16 00:00 UTC).
      const expected =
        Date.UTC(2025, 0, 16, 0, 0, 0) - (T0 + 120_001);
      expect(blocked.retryAfterMs).toBe(expected);
    }
  });

  it('rolls over the day bucket at UTC midnight', async () => {
    const rl = new RateLimiter(
      { msgPerMinute: 100, msgPerDay: 1, newContactsPerDay: 10 },
      T0,
    );
    expect((await rl.tryConsume('msg', T0)).ok).toBe(true);
    expect((await rl.tryConsume('msg', T0 + 60_001)).ok).toBe(false);

    const nextDay = Date.UTC(2025, 0, 16, 0, 0, 1);
    const ok = await rl.tryConsume('msg', nextDay);
    expect(ok.ok).toBe(true);

    const state = rl.getState(nextDay);
    expect(state.msgInDay).toBe(1);
  });

  it('tracks newContactsPerDay independently of msg', async () => {
    const rl = new RateLimiter(
      { msgPerMinute: 100, msgPerDay: 100, newContactsPerDay: 2 },
      T0,
    );
    expect((await rl.tryConsume('newContact', T0)).ok).toBe(true);
    expect((await rl.tryConsume('newContact', T0 + 1_000)).ok).toBe(true);
    const blocked = await rl.tryConsume('newContact', T0 + 2_000);
    expect(blocked.ok).toBe(false);

    // msg is unaffected.
    expect((await rl.tryConsume('msg', T0 + 3_000)).ok).toBe(true);

    const state = rl.getState(T0 + 3_000);
    expect(state.newContactsInDay).toBe(2);
    expect(state.msgInDay).toBe(1);
  });

  it('respects setLimits at runtime', async () => {
    const rl = new RateLimiter(
      { msgPerMinute: 1, msgPerDay: 100, newContactsPerDay: 10 },
      T0,
    );
    await rl.tryConsume('msg', T0);
    expect((await rl.tryConsume('msg', T0 + 1_000)).ok).toBe(false);

    rl.setLimits({ msgPerMinute: 5 });
    expect((await rl.tryConsume('msg', T0 + 2_000)).ok).toBe(true);
    expect(rl.getLimits().msgPerMinute).toBe(5);
  });
});
