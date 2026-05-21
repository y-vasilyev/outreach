import { flags } from '@nosquare/shared';
import { ObjectStore } from './ObjectStore.js';
import { loadStorageConfig } from './config.js';

export { ObjectStore } from './ObjectStore.js';
export {
  loadStorageConfig,
  StorageConfigZ,
  type StorageConfig,
} from './config.js';

let _store: ObjectStore | null | undefined;

/**
 * Flag-aware, lazy accessor for the shared `ObjectStore`. Returns `null`
 * (never throws) when `ENABLE_OBJECT_STORAGE` is off OR the S3_* env is
 * incomplete — so every call site can degrade gracefully. The instance is
 * constructed at most once. Pass `force` in tests to bypass the flag (e.g. the
 * MinIO integration test) — config still must be present.
 */
export function getObjectStore(opts: { force?: boolean } = {}): ObjectStore | null {
  if (_store !== undefined && !opts.force) return _store;
  if (!opts.force && !flags.ENABLE_OBJECT_STORAGE) {
    _store = null;
    return _store;
  }
  const config = loadStorageConfig();
  if (!config) {
    if (!opts.force) _store = null;
    return _store ?? null;
  }
  const store = new ObjectStore(config);
  if (!opts.force) _store = store;
  return store;
}

/** Test/process-reset hook — drops the memoized instance. */
export function resetObjectStore(): void {
  _store = undefined;
}

/**
 * Object key for a blogger media asset. Namespaced per profile + asset so the
 * UI can never enumerate the bucket and access stays presigned-only
 * (spec: "keys namespaced per blogger profile and asset"). When the profile
 * isn't known yet (no channel → no profile), fall back to a conversation-scoped
 * prefix so the byte still lands somewhere deterministic and re-linkable.
 */
export function mediaAssetKey(opts: {
  profileId?: string | null;
  conversationId?: string | null;
  assetId: string;
}): string {
  if (opts.profileId) return `bloggers/${opts.profileId}/${opts.assetId}`;
  if (opts.conversationId) return `conversations/${opts.conversationId}/${opts.assetId}`;
  return `unscoped/${opts.assetId}`;
}

/**
 * Deterministic key for a raw-payload snapshot (verbatim reply text + any
 * parsed JSON), referenced from profile data points for later bulk analysis
 * (spec: "raw response payloads SHALL also be snapshotted ... under a
 * deterministic key"). Keyed by the source message so re-processing the same
 * message overwrites the same object instead of accumulating duplicates.
 *
 * N1: when the blogger profile is known, namespace the key under the profile
 * (`bloggers/{profileId}/raw-payloads/{sourceMessageId}.json`) so a profile's
 * snapshots are co-located and discoverable by prefix. The key still ends in
 * `/{sourceMessageId}.json`, preserving the (profileId, sourceMessageId)
 * linkage to data points (S3). When no profile exists yet, fall back to the
 * conversation-scoped prefix.
 */
export function rawPayloadKey(opts: {
  conversationId: string;
  sourceMessageId: string;
  profileId?: string | null;
}): string {
  if (opts.profileId) {
    return `bloggers/${opts.profileId}/raw-payloads/${opts.sourceMessageId}.json`;
  }
  return `raw-payloads/${opts.conversationId}/${opts.sourceMessageId}.json`;
}

/**
 * Build the verbatim snapshot body. Stable JSON shape so downstream analysis
 * can rely on it. The raw text is preserved exactly; parsed JSON is whatever
 * the extractor produced (may be undefined when nothing parsed).
 */
export function buildRawPayloadSnapshot(opts: {
  conversationId: string;
  sourceMessageId: string;
  rawText: string;
  parsed?: unknown;
}): string {
  return JSON.stringify(
    {
      conversationId: opts.conversationId,
      sourceMessageId: opts.sourceMessageId,
      rawText: opts.rawText,
      parsed: opts.parsed ?? null,
      capturedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}
