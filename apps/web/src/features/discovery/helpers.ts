import { ApiError } from '../../lib/api';
import type {
  DiscoveryBatchStatus,
  DiscoveryBatchStatusEnum,
  GuidedRunDetail,
  GuidedRunStatusEnum,
  CandidateRecommendation,
  CandidateEnrichmentStatus,
} from './types';

/**
 * Pure helpers extracted from DiscoveryBatchStatusPage so the polling
 * predicate and the tone-mapping rules can be unit-tested without
 * mounting the whole component.
 */

export type PollResult = number | false;

/**
 * Decide the next refetch interval for the batch status query.
 *
 * Stops polling (returns `false`) on:
 *   - terminal batch status (`done` | `failed`)
 *   - irrecoverable HTTP errors (403/404): feature-off route (404 without
 *     our application NOT_FOUND code), deleted batch (404 with NOT_FOUND),
 *     auth (403). Refetching every 3s on these would do nothing useful.
 *
 * Otherwise returns the 3-second cadence (matches the worker's ~1s pause
 * between niches without hammering the API).
 */
export function pollInterval(
  data: DiscoveryBatchStatus | undefined,
  err: unknown,
): PollResult {
  if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
    return false;
  }
  if (!data) return 3000;
  return data.status === 'done' || data.status === 'failed' ? false : 3000;
}

export type PillTone = 'ghost' | 'accent' | 'ok' | 'bad';

/** Map a batch's terminal/transitional status to the existing pill tone vocabulary. */
export function statusPill(s: DiscoveryBatchStatusEnum): PillTone {
  if (s === 'done') return 'ok';
  if (s === 'failed') return 'bad';
  if (s === 'running') return 'accent';
  return 'ghost';
}

/** Map a per-query record to a pill tone. An error wins over done. */
export function perQueryPill(q: { done: boolean; error?: string }): 'ghost' | 'ok' | 'bad' {
  if (q.error) return 'bad';
  if (q.done) return 'ok';
  return 'ghost';
}

/** Visible label for a per-query pill; mirrors `perQueryPill`. */
export function perQueryLabel(q: { done: boolean; error?: string }): string {
  if (q.error) return 'error';
  if (q.done) return 'done';
  return 'pending';
}

/**
 * progress = processed / queries; safely returns 0 when queries is 0 (a
 * just-created batch may have no queries scheduled yet — we don't want
 * to render NaN). Clamped to [0, 1] defensively.
 */
export function batchProgress(totals: { processed: number; queries: number } | undefined): number {
  if (!totals || totals.queries === 0) return 0;
  const raw = totals.processed / totals.queries;
  return Math.max(0, Math.min(1, raw));
}

// ─── Guided blogger discovery helpers ───

/**
 * Refetch cadence for a guided run detail. Stops on terminal status or
 * irrecoverable HTTP (403/404), else polls every 2.5s (the worker writes a
 * trace event per stage, so a tighter-than-batch cadence keeps the live log
 * feeling responsive without hammering the API).
 */
export function guidedPollInterval(
  data: GuidedRunDetail | undefined,
  err: unknown,
): PollResult {
  if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
    return false;
  }
  if (!data) return 2500;
  return data.status === 'done' || data.status === 'failed' ? false : 2500;
}

/**
 * Map a guided run status to the existing pill tone vocabulary. `enriching` is
 * a non-terminal "still working" state — accent (live), NOT `ok` — so the UI
 * never shows green while candidates still await an evidence-backed review.
 */
export function guidedStatusPill(s: GuidedRunStatusEnum): PillTone {
  if (s === 'done') return 'ok';
  if (s === 'failed') return 'bad';
  if (s === 'running' || s === 'enriching') return 'accent';
  return 'ghost';
}

/** Map a candidate recommendation to a pill tone. */
export function recommendationPill(r: CandidateRecommendation | null): PillTone {
  if (r === 'strong_fit') return 'ok';
  if (r === 'possible_fit') return 'accent';
  if (r === 'reject') return 'bad';
  return 'ghost'; // weak_fit / null
}

/** Human label for a recommendation (null → "—"). */
export function recommendationLabel(r: CandidateRecommendation | null): string {
  switch (r) {
    case 'strong_fit':
      return 'сильный';
    case 'possible_fit':
      return 'возможный';
    case 'weak_fit':
      return 'слабый';
    case 'reject':
      return 'отказ';
    default:
      return '—';
  }
}

/** Map an enrichment status to a pill tone. */
export function enrichmentPill(s: CandidateEnrichmentStatus): PillTone {
  if (s === 'enriched') return 'ok';
  if (s === 'needs_scrape') return 'bad';
  return 'ghost'; // new / pending_enrichment
}

/** Format a candidate score (0..1) as a percentage, or "—" when unscored. */
export function scoreLabel(score: number | null): string {
  if (score == null) return '—';
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}
