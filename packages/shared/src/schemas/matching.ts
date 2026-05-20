import { z } from 'zod';
import { BloggerProfileZ } from './blogger-profile.js';

/**
 * Blogger matching engine (agency-sourcing-matching change). An incoming ad
 * brief is matched against the catalog; a deterministic prefilter + scoring
 * produces ranked candidates, optionally LLM re-ranked on the top N.
 */
export const AdBriefZ = z.object({
  id: z.string(),
  topic: z.string(),
  audienceTarget: z.string().default(''),
  budget: z.number().int().nonnegative().nullable(),
  formats: z.array(z.string()).default([]),
  geo: z.array(z.string()).default([]),
  deadline: z.string().nullable(),
  notes: z.string().default(''),
  createdAt: z.string(),
});

export const CreateAdBriefInputZ = z.object({
  topic: z.string().min(1),
  audienceTarget: z.string().default(''),
  budget: z.number().int().nonnegative().optional(),
  formats: z.array(z.string()).default([]),
  geo: z.array(z.string()).default([]),
  deadline: z.string().datetime().optional(),
  notes: z.string().default(''),
});

export const MatchResultZ = z.object({
  id: z.string(),
  briefId: z.string(),
  profileId: z.string(),
  score: z.number().min(0).max(1),
  rationale: z.string().default(''),
  rerankedByLlm: z.boolean().default(false),
  createdAt: z.string(),
});

/** A ranked candidate returned from the match endpoint (joined with profile). */
export const MatchCandidateZ = z.object({
  profile: BloggerProfileZ,
  score: z.number().min(0).max(1),
  rationale: z.string(),
  rerankedByLlm: z.boolean(),
});

export const MatchResponseZ = z.object({
  briefId: z.string(),
  candidates: z.array(MatchCandidateZ),
});

export type AdBrief = z.infer<typeof AdBriefZ>;
export type CreateAdBriefInput = z.infer<typeof CreateAdBriefInputZ>;
export type MatchResult = z.infer<typeof MatchResultZ>;
export type MatchCandidate = z.infer<typeof MatchCandidateZ>;
export type MatchResponse = z.infer<typeof MatchResponseZ>;
