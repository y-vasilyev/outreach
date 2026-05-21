import IORedis from 'ioredis';
import { getPrisma } from '@nosquare/db';
import { FeatureFlags, FEATURE_FLAGS_CHANNEL, type FeatureFlagKey } from '@nosquare/shared';

import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Process-wide feature-flags accessor for the API (runtime-feature-flags).
 * Synchronous `get()` reads an in-memory cache; a dedicated Redis subscriber
 * reloads on every published change and on (re)connect. The admin toggle
 * endpoint calls `publishFeatureFlagsChanged()` after a write so every
 * process (api + workers) refreshes.
 */
let _ff: FeatureFlags | undefined;
let _sub: IORedis | undefined;
let _pub: IORedis | undefined;

export function getFeatureFlags(): FeatureFlags {
  if (!_ff) {
    _ff = new FeatureFlags(
      {
        loadAll: () =>
          getPrisma().featureFlag.findMany({ select: { key: true, enabled: true } }),
      },
      {
        subscribe: async (onChange) => {
          _sub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
          _sub.on('message', (channel) => {
            if (channel === FEATURE_FLAGS_CHANNEL) void onChange();
          });
          _sub.on('ready', () => {
            void onChange();
          });
          await _sub.subscribe(FEATURE_FLAGS_CHANNEL);
        },
      },
      { warn: (meta, msg) => logger.warn(meta, msg) },
    );
  }
  return _ff;
}

export async function initFeatureFlags(): Promise<void> {
  await getFeatureFlags().init();
}

/**
 * Refresh this process's cache immediately and notify the others. Called by
 * the admin toggle endpoint after persisting a change.
 */
export async function publishFeatureFlagsChanged(): Promise<void> {
  await getFeatureFlags().refresh();
  if (!_pub) _pub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await _pub.publish(FEATURE_FLAGS_CHANNEL, '1');
}

/** Convenience for route preHandlers. */
export function isFeatureOn(key: FeatureFlagKey): boolean {
  return getFeatureFlags().get(key);
}
