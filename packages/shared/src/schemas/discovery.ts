import { z } from 'zod';
import { PlatformZ } from './common.js';

/**
 * Channel discovery via web search (channel-discovery-search change).
 * A niche query → candidate blogger channels fed into the existing intake.
 */
export const DiscoverySearchInputZ = z.object({
  query: z.string().min(2).max(300),
  /** Narrow discovery to one platform (else all known platforms). */
  platform: PlatformZ.optional(),
  /** Max candidates to persist/enqueue from this search. */
  limit: z.number().int().min(1).max(50).default(20),
});

export const DiscoveryCandidateZ = z.object({
  platform: PlatformZ,
  handle: z.string(),
  url: z.string(),
  title: z.string().default(''),
  /** Whether this candidate already existed as a channel (not re-created). */
  alreadyKnown: z.boolean().default(false),
});

export const DiscoveryResultZ = z.object({
  query: z.string(),
  candidates: z.array(DiscoveryCandidateZ),
  created: z.number().int(),
  enqueued: z.number().int(),
  alreadyKnown: z.number().int(),
});

export type DiscoverySearchInput = z.infer<typeof DiscoverySearchInputZ>;
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateZ>;
export type DiscoveryResult = z.infer<typeof DiscoveryResultZ>;

/**
 * Batch channel discovery (batch-channel-discovery change). One request
 * → many niches → asynchronous worker pipeline → polled status.
 */
export const DiscoveryBatchInputZ = z.object({
  /**
   * Each niche is processed by the worker's duplicated per-niche
   * pipeline (search → normalise → create/skip channel → enqueue
   * channel-scrape). See openspec change `batch-channel-discovery`
   * Decision 1 for the rationale on the deliberate duplication vs
   * a shared helper.
   */
  queries: z.array(z.string().min(2).max(300)).min(1).max(50),
  /** Narrow all niches to one platform, or leave open for all. */
  platform: PlatformZ.optional(),
  /** Max candidates persisted/enqueued per niche (mirrors single-query). */
  limit_per_query: z.number().int().min(1).max(50).default(20),
});

export const DiscoveryBatchPerQueryZ = z.object({
  query: z.string(),
  /** True when this niche has finished (success or error). */
  done: z.boolean().default(false),
  candidates: z.array(DiscoveryCandidateZ).default([]),
  created: z.number().int().default(0),
  alreadyKnown: z.number().int().default(0),
  /** Present iff the niche failed (Yandex 5xx, parse error, etc.). */
  error: z.string().optional(),
});

export const DiscoveryBatchTotalsZ = z.object({
  queries: z.number().int().default(0),
  processed: z.number().int().default(0),
  created: z.number().int().default(0),
  alreadyKnown: z.number().int().default(0),
  errored: z.number().int().default(0),
});

export const DiscoveryBatchSummaryZ = z.object({
  totals: DiscoveryBatchTotalsZ,
  queries: z.array(DiscoveryBatchPerQueryZ).default([]),
  /**
   * Set when the worker couldn't start processing at all (e.g. the
   * `yandex_search` integration is missing or disabled). Per-niche
   * failures live in `queries[i].error`, not here.
   */
  fatalError: z.string().optional(),
});

export const DiscoveryBatchStatusEnumZ = z.enum(['pending', 'running', 'done', 'failed']);

export const DiscoveryBatchStatusZ = z.object({
  id: z.string(),
  status: DiscoveryBatchStatusEnumZ,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  platform: PlatformZ.nullable(),
  limitPerQuery: z.number().int(),
  summary: DiscoveryBatchSummaryZ,
});

/**
 * Compact row shape for `GET /discovery/batch` (list). Excludes the
 * per-query candidates to keep the response small even when many
 * batches have been processed; the full payload is on `GET
 * /discovery/batch/:id`.
 */
export const DiscoveryBatchListItemZ = z.object({
  id: z.string(),
  status: DiscoveryBatchStatusEnumZ,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  platform: PlatformZ.nullable(),
  limitPerQuery: z.number().int(),
  totals: DiscoveryBatchTotalsZ,
});

export type DiscoveryBatchInput = z.infer<typeof DiscoveryBatchInputZ>;
export type DiscoveryBatchSummary = z.infer<typeof DiscoveryBatchSummaryZ>;
export type DiscoveryBatchPerQuery = z.infer<typeof DiscoveryBatchPerQueryZ>;
export type DiscoveryBatchStatus = z.infer<typeof DiscoveryBatchStatusZ>;
export type DiscoveryBatchListItem = z.infer<typeof DiscoveryBatchListItemZ>;
export type DiscoveryBatchStatusEnum = z.infer<typeof DiscoveryBatchStatusEnumZ>;
