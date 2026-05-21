import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FeatureFlags,
  FEATURE_FLAG_DEFAULTS,
  type FeatureFlagLoader,
  type FeatureFlagSubscriber,
} from '@nosquare/shared';

/**
 * Unit tests for the runtime feature-flags accessor (runtime-feature-flags
 * M1). Lives in @nosquare/agents because @nosquare/shared has no test runner;
 * imports the pure accessor from shared.
 */

function loader(rows: Array<{ key: string; enabled: boolean }>): FeatureFlagLoader {
  return { loadAll: async () => rows };
}

afterEach(() => {
  delete process.env.FEATURE_AGENCY_SOURCING_FORCE;
  delete process.env.FEATURE_CAMPAIGN_TYPES_FORCE;
});

describe('FeatureFlags', () => {
  it('get() is synchronous and served from the cache after init (no per-call query)', async () => {
    const loadAll = vi.fn(async () => [{ key: 'agency_sourcing', enabled: true }]);
    const ff = new FeatureFlags({ loadAll });
    await ff.init();

    expect(ff.get('agency_sourcing')).toBe(true);
    ff.get('agency_sourcing');
    ff.get('agency_sourcing');
    // One load at init; get() never queries.
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('defaults to the registry value when the store has no row', async () => {
    const ff = new FeatureFlags(loader([]));
    await ff.init();
    expect(ff.get('agency_sourcing')).toBe(FEATURE_FLAG_DEFAULTS.agency_sourcing); // false
    expect(ff.get('object_storage')).toBe(FEATURE_FLAG_DEFAULTS.object_storage); // false
  });

  it('unknown key resolves to false without throwing', async () => {
    const ff = new FeatureFlags(loader([]));
    await ff.init();
    expect(ff.get('nope_not_a_flag')).toBe(false);
  });

  it('env force-off wins over an enabled DB row; force-on wins over a disabled one', async () => {
    const ff = new FeatureFlags(
      loader([
        { key: 'agency_sourcing', enabled: true },
        { key: 'campaign_types', enabled: false },
      ]),
    );
    await ff.init();
    expect(ff.get('agency_sourcing')).toBe(true);
    expect(ff.get('campaign_types')).toBe(false);

    process.env.FEATURE_AGENCY_SOURCING_FORCE = 'off';
    process.env.FEATURE_CAMPAIGN_TYPES_FORCE = 'on';
    expect(ff.get('agency_sourcing')).toBe(false); // force-off floor
    expect(ff.get('campaign_types')).toBe(true); // force-on
  });

  it('does not hang boot: init resolves with defaults when the loader hangs', async () => {
    // loadAll never resolves (e.g. DB unreachable, connection hangs).
    const ff = new FeatureFlags({ loadAll: () => new Promise(() => {}) }, undefined, {
      initTimeoutMs: 20,
    });
    await expect(ff.init()).resolves.toBeUndefined();
    expect(ff.get('agency_sourcing')).toBe(false);
    expect(ff.get('campaign_types')).toBe(false);
  });

  it('is fail-safe: a loader error keeps registry defaults and does not throw', async () => {
    const ff = new FeatureFlags({
      loadAll: async () => {
        throw new Error('db down');
      },
    });
    await expect(ff.init()).resolves.toBeUndefined();
    expect(ff.get('agency_sourcing')).toBe(false);
    expect(ff.get('campaign_types')).toBe(false);
  });

  it('a published change triggers refresh and updates the cache', async () => {
    let rows = [{ key: 'agency_sourcing', enabled: false }];
    const subscriber: FeatureFlagSubscriber & { fire?: () => void } = {
      subscribe: async (onChange) => {
        subscriber.fire = () => void onChange();
      },
    };
    const ff = new FeatureFlags({ loadAll: async () => rows }, subscriber);
    await ff.init();
    expect(ff.get('agency_sourcing')).toBe(false);

    // Simulate another process toggling it on → publish → our subscriber fires.
    rows = [{ key: 'agency_sourcing', enabled: true }];
    subscriber.fire?.();
    await new Promise((r) => setTimeout(r, 0)); // let the async refresh settle
    expect(ff.get('agency_sourcing')).toBe(true);
  });

  it('snapshot() returns every registry key resolved', async () => {
    const ff = new FeatureFlags(loader([{ key: 'campaign_types', enabled: true }]));
    await ff.init();
    const snap = ff.snapshot();
    expect(snap.campaign_types).toBe(true);
    expect(snap.agency_sourcing).toBe(false);
    expect(Object.keys(snap).sort()).toEqual(
      Object.keys(FEATURE_FLAG_DEFAULTS).sort(),
    );
  });
});
