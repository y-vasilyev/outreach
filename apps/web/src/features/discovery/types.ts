// Local TS mirrors of the @nosquare/shared zod schemas for the channel
// discovery surface. Matches packages/shared/src/schemas/discovery.ts —
// per-feature mirrors keep web independent of the shared package (existing
// convention for other features).

export type Platform = 'telegram' | 'instagram' | 'youtube';
export type DiscoveryBatchStatusEnum = 'pending' | 'running' | 'done' | 'failed';

export interface DiscoveryCandidate {
  platform: Platform;
  handle: string;
  url: string;
  title: string;
  alreadyKnown: boolean;
}

export interface DiscoveryResult {
  query: string;
  candidates: DiscoveryCandidate[];
  created: number;
  enqueued: number;
  alreadyKnown: number;
}

export interface DiscoverySearchInput {
  query: string;
  platform?: Platform;
  limit?: number;
}

export interface DiscoveryBatchInput {
  queries: string[];
  platform?: Platform;
  limit_per_query?: number;
}

export interface DiscoveryBatchPerQuery {
  query: string;
  done: boolean;
  candidates: DiscoveryCandidate[];
  created: number;
  alreadyKnown: number;
  /** Present iff this niche failed. */
  error?: string;
}

export interface DiscoveryBatchTotals {
  queries: number;
  processed: number;
  created: number;
  alreadyKnown: number;
  errored: number;
}

export interface DiscoveryBatchSummary {
  totals: DiscoveryBatchTotals;
  queries: DiscoveryBatchPerQuery[];
  /** Set only when the worker couldn't start (e.g. integration missing). */
  fatalError?: string;
}

export interface DiscoveryBatchStatus {
  id: string;
  status: DiscoveryBatchStatusEnum;
  createdAt: string;
  completedAt: string | null;
  platform: Platform | null;
  limitPerQuery: number;
  summary: DiscoveryBatchSummary;
}

export interface DiscoveryBatchListItem {
  id: string;
  status: DiscoveryBatchStatusEnum;
  createdAt: string;
  completedAt: string | null;
  platform: Platform | null;
  limitPerQuery: number;
  totals: DiscoveryBatchTotals;
}

// ─── Guided blogger discovery (ajtbd-guided-blogger-discovery) ───
// Mirrors packages/shared/src/schemas/discovery.ts guided shapes.

export type GuidedRunStatusEnum = 'pending' | 'running' | 'done' | 'failed';
export type CandidateRecommendation = 'strong_fit' | 'possible_fit' | 'weak_fit' | 'reject';
export type CandidateEnrichmentStatus = 'new' | 'needs_scrape' | 'pending_enrichment' | 'enriched';
export type CandidateDecision = 'saved' | 'shortlisted' | 'rejected';
export type CandidateActionKind = 'save' | 'shortlist' | 'reject' | 'clear' | 'scrape_refresh';
export type DiscoveryTraceStage =
  | 'planner.started'
  | 'planner.completed'
  | 'search.started'
  | 'search.completed'
  | 'candidate.normalized'
  | 'scrape.queued'
  | 'scrape.completed'
  | 'review.started'
  | 'review.completed'
  | 'candidate.recommended'
  | 'budget.truncated'
  | 'error';

export interface GuidedRunBudgets {
  maxQueries: number;
  maxResultsPerQuery: number;
  maxCandidates: number;
  maxReviewed: number;
}

export interface GuidedRunCreateInput {
  campaignId?: string;
  brief?: string;
  platform?: Platform;
  geo?: string[];
  language?: string;
  budgets?: Partial<GuidedRunBudgets>;
}

export interface CampaignAjtbdView {
  job: string;
  when: string;
  desired_outcome: string;
  non_goals: string[];
}

export interface GuidedRunInputSnapshot {
  campaignId: string | null;
  brief: string;
  ajtbd: CampaignAjtbdView | null;
  platform: Platform | null;
  geo: string[];
  language: string | null;
  budgets: GuidedRunBudgets;
}

export interface PlannedQuery {
  query: string;
  platform: Platform | null;
  rationale: string;
  signal: string;
  negativeTerms: string[];
  confidence: number;
}

export interface DiscoveryTraceEvent {
  ts: string;
  stage: DiscoveryTraceStage;
  status: 'ok' | 'error' | 'info';
  message: string;
  query?: string;
  platform?: Platform;
  resultCount?: number;
  candidateCount?: number;
  handle?: string;
  candidateId?: string;
  error?: string;
}

export interface EvidencePost {
  postId: string | null;
  date: string | null;
  snippet: string;
  urls: string[];
  why: string;
}

export interface GuidedRunCandidate {
  id: string;
  channelId: string | null;
  platform: Platform;
  handle: string;
  url: string;
  title: string;
  alreadyKnown: boolean;
  sourceQueries: string[];
  enrichmentStatus: CandidateEnrichmentStatus;
  score: number | null;
  recommendation: CandidateRecommendation | null;
  rationale: string;
  riskNotes: string[];
  evidence: EvidencePost[];
  insufficientEvidenceReason: string | null;
  decision: CandidateDecision | null;
  followers: number | null;
  hasProfile: boolean;
  bloggerProfileId: string | null;
}

export interface GuidedRunSummary {
  plannedQueries: number;
  executedQueries: number;
  failedQueries: number;
  candidatesFound: number;
  candidatesReviewed: number;
  candidatesSkipped: number;
  recommended: number;
  newChannels: number;
  knownChannels: number;
  budgets: GuidedRunBudgets;
  fatalError?: string;
}

export interface GuidedRunDetail {
  id: string;
  status: GuidedRunStatusEnum;
  createdAt: string;
  completedAt: string | null;
  campaignId: string | null;
  input: GuidedRunInputSnapshot;
  plannedQueries: PlannedQuery[];
  trace: DiscoveryTraceEvent[];
  candidates: GuidedRunCandidate[];
  summary: GuidedRunSummary;
}

export interface GuidedRunListItem {
  id: string;
  status: GuidedRunStatusEnum;
  createdAt: string;
  completedAt: string | null;
  campaignId: string | null;
  briefPreview: string;
  platform: Platform | null;
  summary: GuidedRunSummary;
}

/** Minimal campaign shape for the workbench campaign selector. */
export interface DiscoveryCampaignOption {
  id: string;
  name: string;
}
