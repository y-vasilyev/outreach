import type {
  AdBrief,
  BloggerPostInsight,
  BloggerPostInsightPreview,
  BloggerPostMetrics,
  BloggerProfile,
  CatalogFit,
  PostMetricFreshness,
} from './schemas/index.js';

export const POST_METRIC_TTL_DAYS = 30;

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / 86_400_000));
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d;
}

function numericMetricValues(metrics: BloggerPostMetrics): number[] {
  return Object.values(metrics).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  );
}

export function hasNumericPostMetric(metrics: BloggerPostMetrics): boolean {
  return numericMetricValues(metrics).length > 0;
}

export function computePostMetricFreshness(
  input: {
    metrics?: BloggerPostMetrics | null;
    metricCapturedAt?: string | Date | null;
    refreshStatus?: string | null;
  },
  now: Date = new Date(),
  ttlDays = POST_METRIC_TTL_DAYS,
): PostMetricFreshness {
  if (input.refreshStatus === 'pending' || input.refreshStatus === 'refreshing') {
    return { state: 'pending', ageDays: null };
  }
  const metrics = input.metrics ?? {};
  const capturedAt = parseDate(input.metricCapturedAt);
  if (!capturedAt || !hasNumericPostMetric(metrics)) {
    return { state: 'unavailable', ageDays: null };
  }
  const ageDays = daysBetween(now, capturedAt);
  return { state: ageDays > ttlDays ? 'stale' : 'fresh', ageDays };
}

export function scorePostPerformance(
  post: {
    metrics: BloggerPostMetrics;
    metricCapturedAt?: string | Date | null;
    publishedAt?: string | Date | null;
  },
  opts: { avgViews?: number | null; now?: Date; ttlDays?: number } = {},
): number {
  const now = opts.now ?? new Date();
  const freshness = computePostMetricFreshness(post, now, opts.ttlDays ?? POST_METRIC_TTL_DAYS);
  if (freshness.state === 'unavailable') return 0;

  const metrics = post.metrics ?? {};
  const views = metrics.views ?? 0;
  const avgViews = opts.avgViews && opts.avgViews > 0 ? opts.avgViews : null;
  const viewScore = avgViews ? Math.min(1, views / Math.max(avgViews * 2, 1)) : Math.min(1, views / 100_000);
  const engagementRaw =
    (metrics.likes ?? 0) +
    (metrics.comments ?? 0) * 2 +
    (metrics.shares ?? 0) * 3 +
    (metrics.forwards ?? 0) * 3 +
    (metrics.reactions ?? 0);
  const engagementScore = Math.min(1, engagementRaw / Math.max(views || avgViews || 10_000, 1));
  const capturedScore =
    freshness.state === 'fresh' ? 1 : freshness.state === 'pending' ? 0.35 : 0.55;
  const publishedAt = parseDate(post.publishedAt);
  const recencyScore = publishedAt ? Math.max(0.25, 1 - Math.min(daysBetween(now, publishedAt), 180) / 240) : 0.5;

  return Math.max(
    0,
    Math.min(1, viewScore * 0.5 + engagementScore * 0.25 + capturedScore * 0.15 + recencyScore * 0.1),
  );
}

export function rankPostInsightsForPreview(
  posts: BloggerPostInsight[],
  opts: { avgViews?: number | null; limit?: number; now?: Date } = {},
): BloggerPostInsightPreview[] {
  const now = opts.now ?? new Date();
  return posts
    .map((post) => ({
      ...post,
      freshness: computePostMetricFreshness(post, now),
      performanceScore: scorePostPerformance(post, { avgViews: opts.avgViews, now }),
    }))
    .sort((a, b) => {
      if (b.performanceScore !== a.performanceScore) return b.performanceScore - a.performanceScore;
      return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
    })
    .slice(0, opts.limit ?? 3);
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function includesAny(text: string, terms: string[]): boolean {
  const hay = norm(text);
  return terms.some((term) => {
    const t = norm(term);
    return t.length > 1 && hay.includes(t);
  });
}

function briefTerms(brief: Pick<AdBrief, 'topic' | 'audienceTarget' | 'formats' | 'geo' | 'notes'>): string[] {
  return [brief.topic, brief.audienceTarget, ...brief.formats, ...brief.geo, brief.notes]
    .flatMap((s) => String(s ?? '').split(/[^\p{L}\p{N}_-]+/u))
    .filter((s) => s.trim().length > 2);
}

export function buildFitBreakdown(
  brief: Pick<AdBrief, 'topic' | 'audienceTarget' | 'formats' | 'geo' | 'notes'>,
  profile: Pick<BloggerProfile, 'topics' | 'formats' | 'rateCards' | 'reach' | 'avgViews'>,
  scored: {
    score: number;
    rationale: string;
    placement?: { cpmRub: number | null; currency: string; fxAsOf: string | null };
  },
  posts: Array<Pick<BloggerPostInsight, 'id' | 'textSnippet' | 'metrics' | 'freshness'>>,
  source: CatalogFit['source'] = 'deterministic',
): CatalogFit {
  const positiveSignals: string[] = [];
  const gaps: string[] = [];
  const scoreBreakdown: Record<string, number> = { total: scored.score };

  const topicText = profile.topics.join(' ');
  if (brief.topic && includesAny(topicText, [brief.topic, ...briefTerms(brief)])) {
    positiveSignals.push(`topic match: ${brief.topic}`);
    scoreBreakdown.topic = 1;
  } else {
    gaps.push('topic evidence is weak or missing');
    scoreBreakdown.topic = 0;
  }

  if (brief.formats.length === 0 || brief.formats.some((f) => includesAny(profile.formats.join(' '), [f]))) {
    positiveSignals.push('requested format is available or not constrained');
    scoreBreakdown.format = 1;
  } else {
    gaps.push('requested ad format is not confirmed');
    scoreBreakdown.format = 0;
  }

  if ((profile.rateCards?.length ?? 0) > 0) positiveSignals.push('rate card is known');
  else gaps.push('rate card is missing');
  if (profile.reach != null || profile.avgViews != null) positiveSignals.push('reach or average views are known');
  else gaps.push('reach and average views are missing');

  const terms = briefTerms(brief);
  const evidencePostIds = posts
    .filter((p) => includesAny(p.textSnippet, terms))
    .slice(0, 3)
    .map((p) => p.id);
  if (evidencePostIds.length > 0) positiveSignals.push('top posts include brief-relevant content');
  else gaps.push('post evidence is unavailable or not clearly brief-relevant');

  return {
    score: scored.score,
    source,
    rationale: scored.rationale,
    positiveSignals,
    gaps,
    evidencePostIds,
    scoreBreakdown,
    // CPM/fx context of the cited offer (price-normalization-v2) — passes
    // through to fitSignals; informational only.
    ...(scored.placement ? { placement: scored.placement } : {}),
  };
}
