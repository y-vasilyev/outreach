import { z } from 'zod';
import { PlatformZ } from './common.js';
import { CampaignAjtbdZ } from './ajtbd.js';

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

/* ───────────────────────────────────────────────────────────────────────
 * Guided blogger discovery (ajtbd-guided-blogger-discovery change).
 *
 * An LLM-guided run that expands a campaign AJTBD / manual brief into a
 * bounded query plan, executes traceable web searches, enriches candidates
 * with public evidence, and returns a reviewed shortlist. The async worker
 * persists the input snapshot, planned queries, a sanitized operator-visible
 * trace, candidates with evidence, and a budget-aware summary.
 * ─────────────────────────────────────────────────────────────────────── */

/** Per-run cost/coverage budgets. All have safe defaults. */
export const GuidedRunBudgetsZ = z.object({
  /** Max planned queries the worker will execute (planner output is truncated). */
  maxQueries: z.number().int().min(1).max(20).default(8),
  /** Max Yandex results pulled per planned query. */
  maxResultsPerQuery: z.number().int().min(1).max(50).default(20),
  /** Max candidates normalized/persisted across the whole run. */
  maxCandidates: z.number().int().min(1).max(200).default(40),
  /** Max candidates sent to the LLM reviewer (highest-priority first). */
  maxReviewed: z.number().int().min(1).max(100).default(15),
});

/**
 * Create input for `POST /discovery/guided`. Either a `campaignId` (whose
 * goal/AJTBD is loaded) OR a manual `brief` must be supplied — enforced by
 * the refinement below.
 */
export const GuidedRunCreateInputZ = z
  .object({
    campaignId: z.string().optional(),
    /** Free-form niche/AJTBD brief when no campaign is selected. */
    brief: z.string().min(2).max(2000).optional(),
    platform: PlatformZ.optional(),
    geo: z.array(z.string().min(1).max(80)).max(20).default([]),
    language: z.string().min(2).max(20).optional(),
    budgets: GuidedRunBudgetsZ.partial().optional(),
  })
  .refine((v) => Boolean(v.campaignId) || Boolean(v.brief && v.brief.trim().length >= 2), {
    message: 'either campaignId or a manual brief (≥2 chars) is required',
    path: ['brief'],
  });

/**
 * Stable input snapshot resolved by the worker before any agent/search work.
 * Persisted on `DiscoveryRun.input` so the run remains auditable even if the
 * source campaign later changes.
 */
export const GuidedRunInputSnapshotZ = z.object({
  campaignId: z.string().nullable().default(null),
  /** Resolved brief text (campaign goalText or the operator's manual brief). */
  brief: z.string().default(''),
  /** Resolved AJTBD view (present when a campaign was supplied). */
  ajtbd: CampaignAjtbdZ.nullable().default(null),
  platform: PlatformZ.nullable().default(null),
  geo: z.array(z.string()).default([]),
  language: z.string().nullable().default(null),
  budgets: GuidedRunBudgetsZ,
});

/** One planner-produced search query (sanitized, bounded). */
export const PlannedQueryZ = z.object({
  /** Plain niche query text (NOT site-scoped — the search core adds scopes). */
  query: z.string().min(2).max(300),
  /** Target platform, or null to fan across all known platforms. */
  platform: PlatformZ.nullable().default(null),
  rationale: z.string().default(''),
  /** Intended audience/topic signal the query is meant to surface. */
  signal: z.string().default(''),
  negativeTerms: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const DiscoveryTraceStageZ = z.enum([
  'planner.started',
  'planner.completed',
  'search.started',
  'search.completed',
  'candidate.normalized',
  'scrape.queued',
  'scrape.completed',
  'review.started',
  'review.completed',
  'candidate.recommended',
  'budget.truncated',
  'error',
]);

/**
 * One sanitized operator-visible trace event (D4). MUST NOT carry API keys,
 * encrypted config, or private payloads — only counts, query text, handles,
 * and short rationale.
 */
export const DiscoveryTraceEventZ = z.object({
  ts: z.string(),
  stage: DiscoveryTraceStageZ,
  status: z.enum(['ok', 'error', 'info']).default('info'),
  message: z.string().default(''),
  query: z.string().optional(),
  platform: PlatformZ.optional(),
  resultCount: z.number().int().optional(),
  candidateCount: z.number().int().optional(),
  handle: z.string().optional(),
  candidateId: z.string().optional(),
  error: z.string().optional(),
});

/** A public post the reviewer cited as evidence of fit. */
export const EvidencePostZ = z.object({
  postId: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  snippet: z.string().default(''),
  urls: z.array(z.string()).default([]),
  /** Why this post matches the brief. */
  why: z.string().default(''),
});

export const CandidateRecommendationZ = z.enum([
  'strong_fit',
  'possible_fit',
  'weak_fit',
  'reject',
]);

export const CandidateEnrichmentStatusZ = z.enum([
  'new',
  'needs_scrape',
  'pending_enrichment',
  'enriched',
]);

export const CandidateDecisionZ = z.enum(['saved', 'shortlisted', 'rejected', 'launched']);

/** Full candidate shape for the run detail response. */
export const GuidedRunCandidateZ = z.object({
  id: z.string(),
  channelId: z.string().nullable().default(null),
  platform: PlatformZ,
  handle: z.string(),
  url: z.string().default(''),
  title: z.string().default(''),
  alreadyKnown: z.boolean().default(false),
  /** Which planned queries surfaced this candidate (dedup provenance). */
  sourceQueries: z.array(z.string()).default([]),
  enrichmentStatus: CandidateEnrichmentStatusZ.default('new'),
  score: z.number().min(0).max(1).nullable().default(null),
  recommendation: CandidateRecommendationZ.nullable().default(null),
  rationale: z.string().default(''),
  riskNotes: z.array(z.string()).default([]),
  evidence: z.array(EvidencePostZ).default([]),
  /** Set when the reviewer could not assess fit (e.g. not yet scraped). */
  insufficientEvidenceReason: z.string().nullable().default(null),
  decision: CandidateDecisionZ.nullable().default(null),
  followers: z.number().int().nullable().default(null),
  /** Whether a BloggerProfile already exists for the linked channel. */
  hasProfile: z.boolean().default(false),
  /** BloggerProfile id when one exists (for the "open profile" action). */
  bloggerProfileId: z.string().nullable().default(null),
});

export const GuidedRunSummaryZ = z.object({
  plannedQueries: z.number().int().default(0),
  executedQueries: z.number().int().default(0),
  failedQueries: z.number().int().default(0),
  candidatesFound: z.number().int().default(0),
  candidatesReviewed: z.number().int().default(0),
  candidatesSkipped: z.number().int().default(0),
  /** strong_fit + possible_fit count. */
  recommended: z.number().int().default(0),
  newChannels: z.number().int().default(0),
  knownChannels: z.number().int().default(0),
  /**
   * Candidates still awaiting a review (review IS NULL and not budget-skipped)
   * while the run is `enriching`. Drives the operator-visible "ожидают разбора"
   * count so the UI never shows a green `done` while candidates are unreviewed.
   */
  pendingReview: z.number().int().default(0),
  budgets: GuidedRunBudgetsZ,
  /** Set only when the worker could not start (integration missing, etc.). */
  fatalError: z.string().optional(),
});

export const GuidedRunStatusEnumZ = z.enum([
  'pending',
  'running',
  // Phase-1 search/scrape finished but one or more candidates still await an
  // evidence-backed review (scrape hooks + sweep close the loop). Non-terminal
  // — the UI keeps polling and must not present `done` visuals.
  'enriching',
  'done',
  'failed',
]);

export const GuidedRunDetailZ = z.object({
  id: z.string(),
  status: GuidedRunStatusEnumZ,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  campaignId: z.string().nullable(),
  input: GuidedRunInputSnapshotZ,
  plannedQueries: z.array(PlannedQueryZ).default([]),
  trace: z.array(DiscoveryTraceEventZ).default([]),
  candidates: z.array(GuidedRunCandidateZ).default([]),
  summary: GuidedRunSummaryZ,
});

/** Compact row for `GET /discovery/guided` (excludes trace + candidates). */
export const GuidedRunListItemZ = z.object({
  id: z.string(),
  status: GuidedRunStatusEnumZ,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  campaignId: z.string().nullable(),
  /** Short preview of the resolved brief for the list row. */
  briefPreview: z.string().default(''),
  platform: PlatformZ.nullable(),
  summary: GuidedRunSummaryZ,
});

export const CandidateActionZ = z.object({
  action: z.enum(['save', 'shortlist', 'reject', 'clear', 'scrape_refresh', 'launch']),
  /**
   * Target campaign for `launch`. OPTIONAL for every action (including
   * `launch`): the service resolves `campaignId ?? run.campaignId` and errors
   * only when both are absent (D7). Deliberately NOT refined to required for
   * `launch` so the schema and service stay in agreement.
   */
  campaignId: z.string().optional(),
});

export type GuidedRunBudgets = z.infer<typeof GuidedRunBudgetsZ>;
export type GuidedRunCreateInput = z.infer<typeof GuidedRunCreateInputZ>;
export type GuidedRunInputSnapshot = z.infer<typeof GuidedRunInputSnapshotZ>;
export type PlannedQuery = z.infer<typeof PlannedQueryZ>;
export type DiscoveryTraceStage = z.infer<typeof DiscoveryTraceStageZ>;
export type DiscoveryTraceEvent = z.infer<typeof DiscoveryTraceEventZ>;
export type EvidencePost = z.infer<typeof EvidencePostZ>;
export type CandidateRecommendation = z.infer<typeof CandidateRecommendationZ>;
export type CandidateEnrichmentStatus = z.infer<typeof CandidateEnrichmentStatusZ>;
export type CandidateDecision = z.infer<typeof CandidateDecisionZ>;
export type GuidedRunCandidate = z.infer<typeof GuidedRunCandidateZ>;
export type GuidedRunSummary = z.infer<typeof GuidedRunSummaryZ>;
export type GuidedRunStatusEnum = z.infer<typeof GuidedRunStatusEnumZ>;
export type GuidedRunDetail = z.infer<typeof GuidedRunDetailZ>;
export type GuidedRunListItem = z.infer<typeof GuidedRunListItemZ>;
export type CandidateAction = z.infer<typeof CandidateActionZ>;
