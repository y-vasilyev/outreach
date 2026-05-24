import { describe, expect, it } from 'vitest';

import { OpenerStatsQueryZ } from '../schemas/opener-stats.js';

/**
 * `OpenerStatsQueryZ` is the contract that the GET /campaigns/:id/opener-stats
 * route uses to parse query params. It MUST coerce the URL-supplied string
 * `withinHours` into a number, default to 48 when absent, and reject any
 * value outside `[1, 720]`. ab-opener-variants change.
 */
describe('OpenerStatsQueryZ', () => {
  it('defaults withinHours to 48 when absent', () => {
    expect(OpenerStatsQueryZ.parse({}).withinHours).toBe(48);
  });

  it("coerces the URL string '24' to 24", () => {
    expect(OpenerStatsQueryZ.parse({ withinHours: '24' }).withinHours).toBe(24);
  });

  it('accepts the numeric value 720 (top of the inclusive range)', () => {
    expect(OpenerStatsQueryZ.parse({ withinHours: 720 }).withinHours).toBe(720);
  });

  it('accepts 1 (bottom of the inclusive range)', () => {
    expect(OpenerStatsQueryZ.parse({ withinHours: 1 }).withinHours).toBe(1);
  });

  it('rejects 0', () => {
    expect(() => OpenerStatsQueryZ.parse({ withinHours: 0 })).toThrow();
  });

  it('rejects 721', () => {
    expect(() => OpenerStatsQueryZ.parse({ withinHours: 721 })).toThrow();
  });

  it('rejects non-integer values', () => {
    expect(() => OpenerStatsQueryZ.parse({ withinHours: 24.5 })).toThrow();
  });

  it('rejects non-numeric strings', () => {
    expect(() => OpenerStatsQueryZ.parse({ withinHours: 'not a number' })).toThrow();
  });
});
