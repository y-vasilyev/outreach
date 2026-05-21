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
          // enableOfflineQueue:false → fail fast instead of queueing when
          // Redis is down. We do NOT await a subscribe here: boot must never
          // hang on Redis (fail-safe). Subscription + reload happen on every
          // (re)connect via 'ready', which also closes the reconnect window.
          _sub = new IORedis(env.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableOfflineQueue: false,
          });
          _sub.on('error', (e) =>
            logger.warn({ err: (e as Error).message }, 'feature flags: redis subscriber error'),
          );
          _sub.on('message', (channel) => {
            if (channel === FEATURE_FLAGS_CHANNEL) void onChange();
          });
          _sub.on('ready', () => {
            _sub
              ?.subscribe(FEATURE_FLAGS_CHANNEL)
              .catch((e) =>
                logger.warn({ err: (e as Error).message }, 'feature flags: subscribe failed'),
              );
            void onChange();
          });
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
  // Local cache is already refreshed above, so a failed publish only delays
  // OTHER processes' updates (until their next reconnect-reload) — never the
  // toggle itself. Fail fast rather than queue if Redis is down.
  if (!_pub) _pub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false });
  try {
    await _pub.publish(FEATURE_FLAGS_CHANNEL, '1');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'feature flags: publish failed (other processes refresh on reconnect)');
  }
}

/** Convenience for route preHandlers. */
export function isFeatureOn(key: FeatureFlagKey): boolean {
  return getFeatureFlags().get(key);
}
