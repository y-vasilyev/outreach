import { z } from 'zod';
import {
  PlacementAttributeProposalDraftZ,
  PlacementOfferDraftZ,
  PlacementOfferZ,
} from './placement-offer.js';

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

export const SocialProfileLinkZ = z.object({
  platform: z.string().min(1),
  url: z.string().url(),
  handle: z.string().optional(),
});

export const BloggerPostMetricsZ = z
  .object({
    views: z.number().int().nonnegative().optional(),
    likes: z.number().int().nonnegative().optional(),
    comments: z.number().int().nonnegative().optional(),
    shares: z.number().int().nonnegative().optional(),
    forwards: z.number().int().nonnegative().optional(),
    reactions: z.number().int().nonnegative().optional(),
    saves: z.number().int().nonnegative().optional(),
    engagementRate: z.number().min(0).optional(),
  })
  .default({});

export const PostMetricFreshnessZ = z.object({
  state: z.enum(['fresh', 'stale', 'unavailable', 'pending']),
  ageDays: z.number().int().nonnegative().nullable(),
});

export const BloggerPostInsightSourceZ = z.enum([
  'scrapecreators',
  'telegram_public_parse',
  'manual_import',
]);

export const BloggerPostInsightZ = z.object({
  id: z.string(),
  profileId: z.string(),
  channelId: z.string().nullable(),
  platform: z.string().min(1),
  externalPostId: z.string().min(1),
  url: z.string().url().nullable(),
  publishedAt: z.string().nullable(),
  textSnippet: z.string().default(''),
  mediaKind: z.enum(['post', 'story', 'reels', 'shorts', 'video', 'other']).default('post'),
  metrics: BloggerPostMetricsZ,
  metricCapturedAt: z.string().nullable(),
  source: BloggerPostInsightSourceZ,
  sourceRawRef: z.string().nullable().optional(),
  /** Post-example image (blogger-profile-who-is-this). `hasImage` hides the s3 key. */
  hasImage: z.boolean().optional(),
  imageStatus: z.enum(['pending', 'processing', 'ok', 'failed', 'unsupported']).nullable().optional(),
  freshness: PostMetricFreshnessZ,
  performanceScore: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const BloggerPostInsightPreviewZ = BloggerPostInsightZ.pick({
  id: true,
  profileId: true,
  channelId: true,
  platform: true,
  externalPostId: true,
  url: true,
  publishedAt: true,
  textSnippet: true,
  mediaKind: true,
  metrics: true,
  metricCapturedAt: true,
  source: true,
  hasImage: true,
  imageStatus: true,
  freshness: true,
  performanceScore: true,
});

export const PostInsightRefreshStatusZ = z.enum(['idle', 'pending', 'refreshing', 'failed', 'unsupported']);

export const CatalogFitZ = z.object({
  score: z.number().min(0).max(1),
  source: z.enum(['deterministic', 'match_result', 'llm_rerank']),
  rationale: z.string().default(''),
  positiveSignals: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  evidencePostIds: z.array(z.string()).default([]),
  scoreBreakdown: z.record(z.number()).default({}),
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

/**
 * One platform's audience size (placement-representation-v2). Composed from
 * `audience.subscribers.<platform>` data points; distinct from the scalar
 * `reach`/`avgViews` so a multi-platform blogger is comparable per platform.
 */
export const PlatformAudienceEntryZ = z.object({
  platform: z.string().min(1),
  subscribers: z.number().int().nonnegative(),
  source: z.enum(['reply', 'scrapecreators', 'manual_import']).default('reply'),
  capturedAt: z.string().nullable().default(null),
});
export type PlatformAudienceEntry = z.infer<typeof PlatformAudienceEntryZ>;

export const BloggerProfileZ = z.object({
  id: z.string(),
  channelId: z.string().nullable(),
  displayName: z.string().nullable().optional(),
  socialLinks: z.array(SocialProfileLinkZ).default([]).optional(),
  topics: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  formats: z.array(z.string()).default([]),
  audience: AudienceZ,
  rateCards: z.array(RateCardZ).default([]),
  /**
   * Structured placement offers (entity-style-rate-cards). Rolled up from
   * `placement.offer` data points. `rateCards`/`formats` above are derived from
   * these for compatibility when structured offers exist.
   */
  placementOffers: z.array(PlacementOfferZ).default([]),
  /** Per-platform audience sizes (placement-representation-v2). */
  platformAudience: z.array(PlatformAudienceEntryZ).default([]),
  reach: z.number().int().nullable(),
  avgViews: z.number().int().nullable(),
  capturedAt: z.string().nullable(),
  postInsightRefreshStatus: PostInsightRefreshStatusZ.default('idle'),
  postInsightRefreshError: z.string().nullable().optional(),
  postInsightRefreshedAt: z.string().nullable().optional(),
  topPostsPreview: z.array(BloggerPostInsightPreviewZ).default([]).optional(),
  postInsights: z.array(BloggerPostInsightZ).default([]).optional(),
  fit: CatalogFitZ.optional(),
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

/**
 * Output shape shared by the extractor agents (RateCardExtractor,
 * AudienceStatsExtractor). Each emits an array of drafts plus a free-text
 * note. Low-confidence/ambiguous facts are emitted (with a low `confidence`
 * and a rationale baked into `rawSnippet`/note) rather than dropped — an
 * operator reviews them downstream (spec: "Low-confidence extractions are
 * flagged not dropped silently").
 */
export const ProfileExtractionOutputZ = z.object({
  data_points: z.array(ProfileDataPointDraftZ).default([]),
  /**
   * Structured placement offers (entity-style-rate-cards). Emitted alongside
   * legacy `data_points` during rollout. Each carries typed attributes,
   * confidence, and a verbatim source snippet.
   */
  placement_offers: z.array(PlacementOfferDraftZ).default([]),
  /**
   * Inactive proposals for attributes not in the active registry. Routed to
   * operator review; never treated as collected facts or sent to the contact.
   */
  attribute_proposals: z.array(PlacementAttributeProposalDraftZ).default([]),
  /** Optional free-text note (e.g. why nothing was extracted). */
  note: z.string().optional(),
});

export type RateCard = z.infer<typeof RateCardZ>;
export type SocialProfileLink = z.infer<typeof SocialProfileLinkZ>;
export type BloggerPostMetrics = z.infer<typeof BloggerPostMetricsZ>;
export type PostMetricFreshness = z.infer<typeof PostMetricFreshnessZ>;
export type BloggerPostInsight = z.infer<typeof BloggerPostInsightZ>;
export type BloggerPostInsightPreview = z.infer<typeof BloggerPostInsightPreviewZ>;
export type PostInsightRefreshStatus = z.infer<typeof PostInsightRefreshStatusZ>;
export type CatalogFit = z.infer<typeof CatalogFitZ>;
export type Audience = z.infer<typeof AudienceZ>;
export type BloggerProfile = z.infer<typeof BloggerProfileZ>;
export type ProfileDataPoint = z.infer<typeof ProfileDataPointZ>;
export type ProfileDataPointDraft = z.infer<typeof ProfileDataPointDraftZ>;
export type ProfileExtractionOutput = z.infer<typeof ProfileExtractionOutputZ>;
