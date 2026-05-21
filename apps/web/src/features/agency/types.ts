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
  createdAt: string;
}

export interface BloggerProfile {
  id: string;
  channelId: string | null;
  topics: string[];
  languages: string[];
  formats: string[];
  audience: Audience;
  rateCards: RateCard[];
  reach: number | null;
  avgViews: number | null;
  capturedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // detail-only relations / list-only counts
  dataPoints?: ProfileDataPoint[];
  mediaAssets?: MediaAsset[];
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
}

export interface MatchResponse {
  briefId: string;
  candidates: MatchCandidate[];
}
