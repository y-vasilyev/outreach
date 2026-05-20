import { z } from 'zod';

/**
 * Standardized blogger commercial profile (agency-sourcing-matching change).
 *
 * The profile is the queryable catalog row composed deterministically from
 * ProfileDataPoint rows (latest high-confidence per field). Raw provenance
 * lives on the data points; the profile is the rolled-up view used for
 * matching.
 */

/** A rate for one ad format. */
export const RateCardZ = z.object({
  format: z.string().min(1), // "пост", "сторис", "reels", "интеграция"
  price: z.number().nonnegative(),
  currency: z.string().default('RUB'),
  // optional unit/notes, e.g. "за 24ч закреп"
  unit: z.string().optional(),
});

/** Audience breakdown — each map is label → share (0..1) or absolute count. */
export const AudienceZ = z
  .object({
    age: z.record(z.number()).default({}),
    gender: z.record(z.number()).default({}),
    geo: z.record(z.number()).default({}),
  })
  .partial()
  .default({});

export const BloggerProfileZ = z.object({
  id: z.string(),
  channelId: z.string().nullable(),
  topics: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  formats: z.array(z.string()).default([]),
  audience: AudienceZ,
  rateCards: z.array(RateCardZ).default([]),
  reach: z.number().int().nullable(),
  avgViews: z.number().int().nullable(),
  capturedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Provenance row: one harvested fact with confidence + raw source text. */
export const ProfileDataPointZ = z.object({
  id: z.string(),
  profileId: z.string(),
  field: z.string(), // e.g. "reach.story", "rate.post", "audience.geo"
  value: z.unknown(),
  unit: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  extractedBy: z.string().default('llm'),
  sourceMessageId: z.string().nullable(),
  rawSnippet: z.string().default(''),
  capturedAt: z.string(),
  createdAt: z.string(),
});

/** Emitted by extractor agents before persistence. */
export const ProfileDataPointDraftZ = z.object({
  field: z.string().min(1),
  value: z.unknown(),
  unit: z.string().optional(),
  confidence: z.number().min(0).max(1),
  rawSnippet: z.string().default(''),
});

export type RateCard = z.infer<typeof RateCardZ>;
export type Audience = z.infer<typeof AudienceZ>;
export type BloggerProfile = z.infer<typeof BloggerProfileZ>;
export type ProfileDataPoint = z.infer<typeof ProfileDataPointZ>;
export type ProfileDataPointDraft = z.infer<typeof ProfileDataPointDraftZ>;
