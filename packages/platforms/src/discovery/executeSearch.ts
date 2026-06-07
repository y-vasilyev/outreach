import type { Platform } from '../types.js';
import { buildDiscoverySearchQueries } from './searchQueries.js';
import { extractCandidates, type DiscoveredCandidate } from './extractCandidates.js';
import type { YandexSearchResult } from './YandexSearchClient.js';

/**
 * Traceable multi-query search core (ajtbd-guided-blogger-discovery, task 3.1).
 *
 * The lowest reusable layer of channel discovery: given a planned set of
 * queries it runs each through the Yandex client, normalizes results to
 * channel candidates, de-dupes across the whole plan while preserving
 * provenance, and returns sanitized per-query trace metadata.
 *
 * Crucially this layer NEVER sees secrets — the caller constructs the client
 * with the decrypted Search key — so the trace it returns is inherently free
 * of API keys / integration config. It only records query text, platform,
 * counts, status, and timestamps.
 *
 * Both `/discovery/search` (single query) and the guided-discovery worker use
 * this helper so multi-query runs stay auditable and the dedupe/provenance
 * logic lives in one place.
 */

/** Minimal surface of the Yandex client this helper needs. */
export interface DiscoverySearchClient {
  search(query: string): Promise<YandexSearchResult[]>;
}

/** One planned query: plain niche text + optional platform scope. */
export interface PlannedSearchInput {
  query: string;
  platform?: Platform | null;
}

/** A candidate enriched with cross-query provenance. */
export interface TraceableCandidate extends DiscoveredCandidate {
  /** The planned query that first surfaced this candidate. */
  sourceQuery: string;
  /** Every planned query that surfaced it (dedup provenance). */
  sourceQueries: string[];
}

/** Sanitized per-query trace record. Contains no secrets by construction. */
export interface SearchQueryTrace {
  query: string;
  platform: Platform | null;
  status: 'ok' | 'error';
  resultCount: number;
  candidateCount: number;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface ExecuteSearchResult {
  /** Candidates de-duplicated across all planned queries (capped overall). */
  candidates: TraceableCandidate[];
  /** One record per planned query, in input order. */
  trace: SearchQueryTrace[];
}

export interface ExecuteSearchOptions {
  /** Max candidates kept per planned query before global dedupe. */
  limitPerQuery?: number;
  /** Hard cap on total de-duplicated candidates returned. */
  maxCandidates?: number;
}

/**
 * Execute a planned set of searches. Query-level failures are isolated: a
 * failing query is recorded in the trace and the remaining queries still
 * produce candidates (the whole run is only barren if every query failed).
 */
export async function executePlannedSearches(
  client: DiscoverySearchClient,
  planned: PlannedSearchInput[],
  opts: ExecuteSearchOptions = {},
): Promise<ExecuteSearchResult> {
  const limitPerQuery = opts.limitPerQuery ?? 20;
  const maxCandidates = opts.maxCandidates ?? Number.POSITIVE_INFINITY;

  const trace: SearchQueryTrace[] = [];
  // platform:handle → candidate (with merged provenance).
  const byKey = new Map<string, TraceableCandidate>();

  for (const p of planned) {
    const platform = p.platform ?? null;
    const startedAt = new Date().toISOString();
    try {
      const subQueries = buildDiscoverySearchQueries(p.query, {
        ...(platform ? { platform } : {}),
      });
      const results = (await Promise.all(subQueries.map((q) => client.search(q)))).flat();
      const candidates = extractCandidates(
        results,
        platform ? { platform } : {},
      ).slice(0, limitPerQuery);

      for (const c of candidates) {
        const key = `${c.platform}:${c.handle.replace(/^@/, '').toLowerCase()}`;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.sourceQueries.includes(p.query)) {
            existing.sourceQueries.push(p.query);
          }
          continue;
        }
        if (byKey.size >= maxCandidates) continue;
        byKey.set(key, {
          ...c,
          sourceQuery: p.query,
          sourceQueries: [p.query],
        });
      }

      trace.push({
        query: p.query,
        platform,
        status: 'ok',
        resultCount: results.length,
        candidateCount: candidates.length,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      trace.push({
        query: p.query,
        platform,
        status: 'error',
        resultCount: 0,
        candidateCount: 0,
        error: (err as Error).message,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    }
  }

  return { candidates: [...byKey.values()], trace };
}
