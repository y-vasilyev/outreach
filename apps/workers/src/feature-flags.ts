import IORedis from 'ioredis';
import { getPrisma } from '@nosquare/db';
import { FeatureFlags, FEATURE_FLAGS_CHANNEL } from '@nosquare/shared';

import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Process-wide feature-flags accessor for the workers (runtime-feature-flags).
 * Synchronous `get()` reads from an in-memory cache; a dedicated Redis
 * subscriber reloads the cache on every published change AND on (re)connect
 * (closing the missed-message window across reconnects).
 */
let _ff: FeatureFlags | undefined;
let _sub: IORedis | undefined;

export function getFeatureFlags(): FeatureFlags {
  if (!_ff) {
    _ff = new FeatureFlags(
      {
        loadAll: () =>
          getPrisma().featureFlag.findMany({ select: { key: true, enabled: true } }),
      },
      {
        subscribe: async (onChange) => {
          // enableOfflineQueue:false → commands fail fast instead of queueing
          // when Redis is down. We do NOT await a subscribe here: boot must
          // never hang on Redis (fail-safe). Subscription + reload happen on
          // every (re)connect via the 'ready' handler, which also closes the
          // reconnect missed-message window.
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
                logger.warn(
                  { err: (e as Error).message },
                  'feature flags: subscribe failed',
                ),
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

/** Load the cache + subscribe. Call once at worker boot. */
export async function initFeatureFlags(): Promise<void> {
  await getFeatureFlags().init();
}
