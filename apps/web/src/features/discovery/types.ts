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
