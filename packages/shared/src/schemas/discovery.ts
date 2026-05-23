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
