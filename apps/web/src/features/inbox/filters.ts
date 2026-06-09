import type { LocationQuery } from 'vue-router';

/**
 * Inbox filter shape that mirrors the API contract (`ConversationFiltersZ`
 * in `@nosquare/shared`). Kept as a plain object so it can serialise into
 * a URL query string and a React Query key without ceremony.
 *
 * The full source of truth is the URL — see Decision 1 in
 * inbox-campaign-filter design.md.
 */
export interface InboxFilters {
  campaignId?: string;
  status?: 'active' | 'paused' | 'done' | 'failed' | 'archived';
  mode?: 'auto' | 'semi_auto' | 'assisted' | 'manual';
  /** Direction: 'i_messaged' = кому я написал, 'they_replied' = кто мне ответил. */
  activity?: 'i_messaged' | 'they_replied';
  assignedOperatorId?: string;
  q?: string;
}

const STATUS = new Set(['active', 'paused', 'done', 'failed', 'archived']);
const MODE = new Set(['auto', 'semi_auto', 'assisted', 'manual']);
const ACTIVITY = new Set(['i_messaged', 'they_replied']);

function readString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

/**
 * Parse a `route.query` object into a typed, whitelisted `InboxFilters`.
 * Unknown keys are ignored; unknown enum values are dropped silently
 * (the API would 400 anyway, no point round-tripping garbage).
 */
export function parseInboxFilters(query: LocationQuery): InboxFilters {
  const status = readString(query.status);
  const mode = readString(query.mode);
  const activity = readString(query.activity);
  return {
    campaignId: readString(query.campaignId),
    status: status && STATUS.has(status) ? (status as InboxFilters['status']) : undefined,
    mode: mode && MODE.has(mode) ? (mode as InboxFilters['mode']) : undefined,
    activity: activity && ACTIVITY.has(activity) ? (activity as InboxFilters['activity']) : undefined,
    assignedOperatorId: readString(query.assignedOperatorId),
    q: readString(query.q),
  };
}

/**
 * Merge a partial patch into the current URL query, dropping keys whose
 * value is `undefined` / `""`. The result is a plain record that can be
 * passed directly to `router.push({ query })`.
 */
export function mergeFilterQuery(
  current: LocationQuery,
  patch: Partial<InboxFilters>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (typeof v === 'string' && v.length > 0) merged[k] = v;
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      delete merged[k];
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : String(v);
    if (s.length === 0) {
      delete merged[k];
    } else {
      merged[k] = s;
    }
  }
  return merged;
}

export function hasAnyFilter(f: InboxFilters): boolean {
  return Boolean(f.campaignId || f.status || f.mode || f.activity || f.assignedOperatorId || f.q);
}
