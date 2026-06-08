// Local mirrors of the @nosquare/shared zod-inferred types for the agency
// sourcing & matching surfaces. The web app deliberately keeps per-feature
// `types.ts` rather than importing the shared package (matching existing
// features), so these track the shapes in
// packages/shared/src/schemas/{blogger-profile,matching,media-asset}.ts.

export interface RateCard {
  format: string;
  price: number;
  currency: string;
  unit?: string;
}

export interface SocialProfileLink {
  platform: string;
  url: string;
  handle?: string;
}

// Structured placement offer (entity-style-rate-cards). Mirrors
// packages/shared/src/schemas/placement-offer.ts (PlacementOffer/PlacementAttribute).
export type PlacementAttributeValue = string | number | boolean | string[];

export interface PlacementAttribute {
  key: string;
  value: PlacementAttributeValue;
  confidence: number;
  rawSnippet: string;
}

export interface PlacementOffer {
  kind: string;
  platform: string | null;
  price: number | null;
  currency: string;
  attributes: PlacementAttribute[];
  confidence: number;
  rawSnippet: string;
  sourceMessageId: string | null;
  extractedBy: string;
  capturedAt: string | null;
}

// Per-platform audience size (placement-representation-v2). Mirror of
// packages/shared/src/schemas/blogger-profile.ts (PlatformAudienceEntry).
export interface PlatformAudienceEntry {
  platform: string;
  subscribers: number;
  source: 'reply' | 'scrapecreators' | 'manual_import';
  capturedAt: string | null;
}

export interface Audience {
  age?: Record<string, number>;
  gender?: Record<string, number>;
  geo?: Record<string, number>;
}

export interface MediaAsset {
  id: string;
  kind: string;
  mime: string | null;
  bytes: number | null;
  /** OCR status (attachment-ocr-ingestion). */
  ocrStatus?: 'pending' | 'processing' | 'ok' | 'failed' | 'unsupported' | null;
  createdAt: string;
}

export interface BloggerPostMetrics {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  forwards?: number;
  reactions?: number;
  saves?: number;
  engagementRate?: number;
}

export type PostMetricFreshnessState = 'fresh' | 'stale' | 'unavailable' | 'pending';

export interface PostMetricFreshness {
  state: PostMetricFreshnessState;
  ageDays: number | null;
}

export interface BloggerPostInsight {
  id: string;
  profileId: string;
  channelId: string | null;
  platform: string;
  externalPostId: string;
  url: string | null;
  publishedAt: string | null;
  textSnippet: string;
  mediaKind: 'post' | 'story' | 'reels' | 'shorts' | 'video' | 'other';
  metrics: BloggerPostMetrics;
  metricCapturedAt: string | null;
  source: 'scrapecreators' | 'telegram_public_parse' | 'manual_import';
  sourceRawRef?: string | null;
  freshness: PostMetricFreshness;
  performanceScore: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CatalogFit {
  score: number;
  source: 'deterministic' | 'match_result' | 'llm_rerank';
  rationale: string;
  positiveSignals: string[];
  gaps: string[];
  evidencePostIds: string[];
  scoreBreakdown: Record<string, number>;
}

export type PostInsightRefreshStatus = 'idle' | 'pending' | 'refreshing' | 'failed' | 'unsupported';

export type ProfileFreshnessCategory =
  | 'rateCards'
  | 'audience'
  | 'topics'
  | 'languages'
  | 'formats'
  | 'reach'
  | 'avgViews';

export interface ProfileFreshnessSection {
  stale: boolean;
  ageDays: number | null;
}

export type ProfileFreshness = Record<ProfileFreshnessCategory, ProfileFreshnessSection>;

export interface BloggerProfile {
  id: string;
  channelId: string | null;
  displayName?: string | null;
  socialLinks?: SocialProfileLink[];
  topics: string[];
  languages: string[];
  formats: string[];
  audience: Audience;
  rateCards: RateCard[];
  placementOffers?: PlacementOffer[];
  platformAudience?: PlatformAudienceEntry[];
  reach: number | null;
  avgViews: number | null;
  capturedAt: string | null;
  postInsightRefreshStatus: PostInsightRefreshStatus;
  postInsightRefreshError?: string | null;
  postInsightRefreshedAt?: string | null;
  topPostsPreview?: BloggerPostInsight[];
  postInsights?: BloggerPostInsight[];
  fit?: CatalogFit;
  createdAt: string;
  updatedAt: string;
  // detail-only relations / list-only counts
  dataPoints?: ProfileDataPoint[];
  mediaAssets?: MediaAsset[];
  freshness?: ProfileFreshness;
  _count?: { dataPoints: number };
}

export interface ProfileDataPoint {
  id: string;
  profileId: string;
  field: string;
  value: unknown;
  unit: string | null;
  confidence: number;
  extractedBy: string;
  sourceMessageId: string | null;
  rawSnippet: string;
  capturedAt: string;
  createdAt: string;
}

export interface BloggerProfileList {
  items: BloggerProfile[];
  total: number;
  limit: number;
  offset: number;
}

export interface PresignedUrl {
  url: string;
  expiresInSeconds: number;
}

// ─── Matching ───

export interface AdBrief {
  id: string;
  topic: string;
  audienceTarget: string;
  budget: number | null;
  formats: string[];
  geo: string[];
  deadline: string | null;
  notes: string;
  createdAt: string;
}

export interface CreateAdBriefInput {
  topic: string;
  audienceTarget?: string;
  budget?: number;
  formats?: string[];
  geo?: string[];
  deadline?: string;
  notes?: string;
}

export interface MatchCandidate {
  profile: BloggerProfile;
  score: number;
  rationale: string;
  rerankedByLlm: boolean;
  fit?: Omit<CatalogFit, 'source'>;
}

export interface MatchResponse {
  briefId: string;
  candidates: MatchCandidate[];
}
