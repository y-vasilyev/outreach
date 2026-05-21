/**
 * Runtime feature flags (runtime-feature-flags change).
 *
 * The DB `feature_flag` table is the source of truth; this module holds the
 * pure, IO-free core: the closed registry of toggleable keys + defaults, the
 * env force-override resolution, and a synchronous in-memory cache. Apps wire
 * the IO (a prisma-backed loader + a Redis-backed subscriber) and call
 * `init()` at boot — keeping `@nosquare/shared` free of DB/Redis deps.
 *
 * `get(key)` is synchronous and safe on the inbound hot path (it never
 * queries). Cross-process propagation: a write publishes to
 * `FEATURE_FLAGS_CHANNEL`; every subscriber calls `refresh()`.
 */

/** Redis pub/sub channel used to invalidate flag caches across processes. */
export const FEATURE_FLAGS_CHANNEL = 'feature_flags:changed';

/**
 * Closed set of runtime-toggleable flags + their default value (used when the
 * store has no row, the key is unknown, or the store is unreachable).
 *
 * Scope: the agency-sourcing-matching rollout/kill switches — all default
 * OFF, exactly today's effective state, so the cutover is behavior-preserving.
 * Pure product constants and other operational flags (e.g.
 * `ENABLE_FOLLOWUP_CRON`, `ENABLE_QUALITY_REVIEW`) stay in `flags.ts` and are
 * intentionally NOT runtime-managed here; the table can absorb them later.
 */
export const FEATURE_FLAG_DEFAULTS = {
  campaign_types: false,
  agency_sourcing: false,
  object_storage: false,
  blogger_matching: false,
} as const;

export type FeatureFlagKey = keyof typeof FEATURE_FLAG_DEFAULTS;

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAG_DEFAULTS) as FeatureFlagKey[];

export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAG_DEFAULTS, key);
}

/**
 * Env emergency override: `FEATURE_<KEY>_FORCE=on|off` (also true/false/1/0).
 * Returns undefined when unset/unparseable so the DB value is used.
 */
export function featureForceOverride(
  key: FeatureFlagKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const raw = env[`FEATURE_${key.toUpperCase()}_FORCE`];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return undefined;
}

/** Keys currently pinned by an env force-override (for startup logging). */
export function pinnedFeatureForces(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ key: FeatureFlagKey; value: boolean }> {
  const out: Array<{ key: FeatureFlagKey; value: boolean }> = [];
  for (const key of FEATURE_FLAG_KEYS) {
    const v = featureForceOverride(key, env);
    if (v !== undefined) out.push({ key, value: v });
  }
  return out;
}

/** Loads the current flag rows. App-provided (prisma-backed). */
export interface FeatureFlagLoader {
  loadAll(): Promise<Array<{ key: string; enabled: boolean }>>;
}

/** Subscribes to cross-process invalidation. App-provided (Redis-backed). */
export interface FeatureFlagSubscriber {
  subscribe(onChange: () => void | Promise<void>): Promise<void>;
}

export interface FeatureFlagsOptions {
  /** Structured warning sink (e.g. pino). */
  warn?: (meta: Record<string, unknown>, msg: string) => void;
}

export class FeatureFlags {
  private cache: Map<FeatureFlagKey, boolean>;
  private readonly loader: FeatureFlagLoader;
  private readonly subscriber?: FeatureFlagSubscriber;
  private readonly warn: (meta: Record<string, unknown>, msg: string) => void;

  constructor(
    loader: FeatureFlagLoader,
    subscriber?: FeatureFlagSubscriber,
    opts: FeatureFlagsOptions = {},
  ) {
    this.loader = loader;
    this.subscriber = subscriber;
    this.warn = opts.warn ?? (() => {});
    this.cache = this.defaultsMap();
  }

  private defaultsMap(): Map<FeatureFlagKey, boolean> {
    return new Map(FEATURE_FLAG_KEYS.map((k) => [k, FEATURE_FLAG_DEFAULTS[k]]));
  }

  /**
   * Subscribe to invalidation, then load the cache. Never throws.
   *
   * Order matters: we register the change handler BEFORE the initial load so a
   * toggle that lands during startup still triggers a reload (no missed-message
   * window). The injected subscriber MUST also invoke `onChange` on Redis
   * (re)connect so a process can't stay stale across a reconnect (see the
   * Redis-backed subscriber in the apps).
   */
  async init(): Promise<void> {
    // Surface any env force-overrides so operators know a flag is pinned.
    const pinned = pinnedFeatureForces();
    if (pinned.length > 0) {
      this.warn({ pinned }, 'feature flags: env force-overrides active (FEATURE_<KEY>_FORCE)');
    }

    if (this.subscriber) {
      try {
        await this.subscriber.subscribe(() => {
          void this.refresh();
        });
      } catch (e) {
        this.warn(
          { err: (e as Error).message },
          'feature flags: subscribe failed; running without live invalidation',
        );
      }
    }
    await this.refresh();
  }

  /**
   * Reload the cache from the store. Fail-safe: on error it keeps the
   * last-known-good cache (registry defaults if no successful load yet) and
   * never partially applies a load.
   */
  async refresh(): Promise<void> {
    try {
      const rows = await this.loader.loadAll();
      const next = this.defaultsMap();
      for (const r of rows) {
        if (isFeatureFlagKey(r.key)) next.set(r.key, r.enabled);
      }
      this.cache = next;
    } catch (e) {
      this.warn(
        { err: (e as Error).message },
        'feature flags: load failed; using defaults (all rollout flags off)',
      );
    }
  }

  /**
   * Synchronous, hot-path safe. Resolution order: env force > cached DB value
   * > registry default. Unknown keys resolve to `false`.
   */
  get(key: FeatureFlagKey | string): boolean {
    if (!isFeatureFlagKey(key)) return false;
    const forced = featureForceOverride(key);
    if (forced !== undefined) return forced;
    return this.cache.get(key) ?? FEATURE_FLAG_DEFAULTS[key];
  }

  /** Resolved snapshot of every flag (for the /config endpoint + admin list). */
  snapshot(): Record<FeatureFlagKey, boolean> {
    const out = {} as Record<FeatureFlagKey, boolean>;
    for (const k of FEATURE_FLAG_KEYS) out[k] = this.get(k);
    return out;
  }
}
