import {
  getPrisma,
  type BloggerProfile as DbBloggerProfile,
  type AdBrief as DbAdBrief,
  type BloggerPostInsight as DbBloggerPostInsight,
} from '@nosquare/db';
import {
  Errors,
  buildFitBreakdown,
  computePostMetricFreshness,
  rankPostInsightsForPreview,
  rankProfiles,
  structuredPlacementScore,
  BloggerPostMetricsZ,
  RateCardZ,
  AudienceZ,
  PlacementOfferZ,
  PlatformAudienceEntryZ,
  type AdBrief,
  type BloggerPostInsight,
  type CatalogFit,
  type MatchableProfile,
  type ScoredProfile,
  type RateCard,
  type Audience,
  type PlacementOffer,
  type PlatformAudienceEntry,
} from '@nosquare/shared';
import type { CreateAdBriefInput } from '@nosquare/shared';

import { getAgentRunner } from './agents.js';
import { getFeatureFlags } from '../feature-flags.js';
import { logger } from '../logger.js';

/**
 * Blogger matching service (agency-sourcing-matching M7, tasks 7.1–7.5).
 *
 * Two-stage filter→score (design D6): a deterministic prefilter + scoring
 * (pure functions in `@nosquare/shared/matching`) produces ranked candidates;
 * an OPTIONAL `blogger_matcher` LLM re-rank, bounded to the top N, refines the
 * head of the list. Every match run persists `match_result` rows for audit.
 */

/** Default cap on how many top candidates reach the LLM re-rank. */
const DEFAULT_RERANK_TOP_N = 10;

/** Coerce the AdBrief DB row into the shared zod-shaped AdBrief. */
function toBrief(row: DbAdBrief): AdBrief {
  return {
    id: row.id,
    topic: row.topic,
    audienceTarget: row.audienceTarget,
    budget: row.budget ?? null,
    formats: row.formats,
    geo: row.geo,
    deadline: row.deadline ? row.deadline.toISOString() : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Parse a DB profile's JSON columns into typed rate cards / audience. */
function parseRateCards(value: unknown): RateCard[] {
  const arr = Array.isArray(value) ? value : [];
  const out: RateCard[] = [];
  for (const item of arr) {
    const parsed = RateCardZ.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function parseAudience(value: unknown): Audience {
  const parsed = AudienceZ.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/** Parse the profile's `placementOffers` JSON column into typed offers. */
function parsePlacementOffers(value: unknown): PlacementOffer[] {
  const arr = Array.isArray(value) ? value : [];
  const out: PlacementOffer[] = [];
  for (const item of arr) {
    const parsed = PlacementOfferZ.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function parsePlatformAudience(value: unknown): PlatformAudienceEntry[] {
  const arr = Array.isArray(value) ? value : [];
  const out: PlatformAudienceEntry[] = [];
  for (const item of arr) {
    const parsed = PlatformAudienceEntryZ.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function toMatchable(p: DbBloggerProfile): MatchableProfile {
  return {
    id: p.id,
    topics: p.topics,
    languages: p.languages,
    formats: p.formats,
    audience: parseAudience(p.audience),
    rateCards: parseRateCards(p.rateCards),
    placementOffers: parsePlacementOffers((p as { placementOffers?: unknown }).placementOffers),
    platformAudience: parsePlatformAudience((p as { platformAudience?: unknown }).platformAudience),
    reach: p.reach ?? null,
    avgViews: p.avgViews ?? null,
  };
}

function serializePostInsight(row: DbBloggerPostInsight): BloggerPostInsight {
  const metrics = BloggerPostMetricsZ.parse(row.metrics ?? {});
  const base = {
    id: row.id,
    profileId: row.profileId,
    channelId: row.channelId ?? null,
    platform: row.platform,
    externalPostId: row.externalPostId,
    url: row.url ?? null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    textSnippet: row.textSnippet,
    mediaKind: row.mediaKind as BloggerPostInsight['mediaKind'],
    metrics,
    metricCapturedAt: row.metricCapturedAt ? row.metricCapturedAt.toISOString() : null,
    source: row.source as BloggerPostInsight['source'],
    sourceRawRef: row.sourceRawRef ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return {
    ...base,
    freshness: computePostMetricFreshness(base),
    performanceScore: 0,
  };
}

function fitSignalsForPersist(fit: CatalogFit) {
  return {
    positiveSignals: fit.positiveSignals,
    gaps: fit.gaps,
    scoreBreakdown: fit.scoreBreakdown,
    ...(fit.placement ? { placement: fit.placement } : {}),
  };
}

export interface MatchOptions {
  /** When true, run the bounded LLM re-rank on the top N (default false). */
  rerank?: boolean;
  /** Cap for the LLM re-rank head (default DEFAULT_RERANK_TOP_N). */
  topN?: number;
}

export const matchingService = {
  async createBrief(input: CreateAdBriefInput, userId?: string) {
    const prisma = getPrisma();
    const created = await prisma.adBrief.create({
      data: {
        topic: input.topic,
        audienceTarget: input.audienceTarget,
        budget: input.budget ?? null,
        formats: input.formats,
        geo: input.geo,
        deadline: input.deadline ? new Date(input.deadline) : null,
        notes: input.notes,
        createdById: userId ?? null,
      },
    });
    return created;
  },

  async getBrief(id: string) {
    const prisma = getPrisma();
    const brief = await prisma.adBrief.findUnique({ where: { id } });
    if (!brief) throw Errors.notFound('ad_brief', id);
    return brief;
  },

  /**
   * Run matching for a persisted brief: prefilter + score the catalog,
   * optionally LLM re-rank the top N, persist `match_result` rows, and return
   * the ranked candidates joined with their profiles (MatchResponse shape).
   */
  async match(briefId: string, opts: MatchOptions = {}) {
    const prisma = getPrisma();
    const briefRow = await prisma.adBrief.findUnique({ where: { id: briefId } });
    if (!briefRow) throw Errors.notFound('ad_brief', briefId);
    const brief = toBrief(briefRow);

    // Catalog. The prefilter is the cheap part — for a ~200-row catalog we load
    // and refine in memory (Prisma can't cleanly express topic/geo/budget
    // overlap across JSON columns + arrays). A coarse topic prefilter on the
    // indexed `topics` array narrows the load before the precise pure pass.
    // S7: the in-memory prefilter is fine at this scale. Pushing a coarse
    // topic/format filter into SQL (e.g. `topics` array overlap) to avoid
    // loading the whole catalog is a DEFERRED optimization — revisit when the
    // catalog outgrows a few hundred rows.
    const profilesRows = await prisma.bloggerProfile.findMany({
      orderBy: { updatedAt: 'desc' },
    });
    const profiles = profilesRows.map(toMatchable);
    const profileById = new Map(profilesRows.map((p) => [p.id, p]));
    const postRows = await prisma.bloggerPostInsight.findMany({
      where: { profileId: { in: profilesRows.map((p) => p.id) } },
      orderBy: [{ metricCapturedAt: 'desc' }, { publishedAt: 'desc' }],
    });
    const postsByProfile = new Map<string, BloggerPostInsight[]>();
    for (const row of postRows) {
      const arr = postsByProfile.get(row.profileId) ?? [];
      arr.push(serializePostInsight(row));
      postsByProfile.set(row.profileId, arr);
    }

    // `structured_placement_offers` rollout: when ON, matching prefers a
    // profile's structured placement offers and falls back to legacy rateCards
    // per-profile (those without offers). When OFF, matching is legacy-only and
    // byte-identical to the pre-change behavior. The flag is read HERE (impure
    // service) and passed into the pure matcher — `matching.ts` never reads it.
    const useStructuredOffers = getFeatureFlags().get('structured_placement_offers');
    const matchOpts = { useStructuredOffers };

    // Stage 1+2: deterministic prefilter → score → order.
    let ranked: ScoredProfile[] = rankProfiles(brief, profiles, matchOpts);
    const rerankedIds = new Set<string>();
    const deterministicFit = new Map<string, CatalogFit>();
    for (const r of ranked) {
      const profileRow = profileById.get(r.profileId);
      if (!profileRow) continue;
      const profile = serializeProfile(profileRow);
      deterministicFit.set(
        r.profileId,
        buildFitBreakdown(brief, profile, r, postsByProfile.get(r.profileId) ?? [], 'deterministic'),
      );
    }

    // Stage 3 (optional): bounded LLM re-rank of the top N.
    const topN = Math.max(1, opts.topN ?? DEFAULT_RERANK_TOP_N);
    if (opts.rerank && ranked.length > 0) {
      const head = ranked.slice(0, topN);
      const tail = ranked.slice(topN);
      try {
        const candidates = head.map((s) => {
          const p = profileById.get(s.profileId);
          const mp = p ? toMatchable(p) : undefined;
          const offers = mp?.placementOffers ?? [];
          // Structured placement terms used for scoring (entity-style-rate-cards
          // task 5.2). Only populated when the flag is on AND the profile has
          // offers, so the model reasons over the same terms that drove the
          // deterministic format/budget sub-scores. The best-fit offer's
          // terms feed the compact `placement_terms` summary the prompt cites.
          const useOffersForCand = useStructuredOffers && offers.length > 0;
          const structured = useOffersForCand ? structuredPlacementScore(brief, offers) : undefined;
          return {
            profile_id: s.profileId,
            score: s.score,
            rationale: s.rationale,
            topics: mp?.topics ?? [],
            languages: mp?.languages ?? [],
            formats: mp?.formats ?? [],
            geo: Object.keys((mp?.audience as { geo?: Record<string, number> } | undefined)?.geo ?? {}),
            rate_cards: (mp?.rateCards ?? []).map((rc) => ({
              format: rc.format,
              price: rc.price,
              currency: rc.currency,
            })),
            placement_offers: useOffersForCand
              ? offers.map((o) => ({
                  kind: o.kind,
                  platform: o.platform,
                  price: o.price,
                  currency: o.currency,
                  attributes: o.attributes.map((a) => ({ key: a.key, value: a.value })),
                }))
              : [],
            placement_terms: structured?.bestSummary ?? '',
            reach: mp?.reach ?? null,
          };
        });

        const out = await getAgentRunner().run<{
          ranked: { profile_id: string; score: number; rationale: string }[];
        }>('blogger_matcher', {
          brief: {
            topic: brief.topic,
            audience_target: brief.audienceTarget,
            budget: brief.budget,
            formats: brief.formats,
            geo: brief.geo,
            notes: brief.notes,
          },
          candidates,
          // The seeded default has enable_llm_rerank=false; the route only
          // reaches here when re-rank was explicitly requested, so flip it on
          // for this run via a param override.
        }, { overrides: { params: { enable_llm_rerank: true } } });

        const rerankedHead: ScoredProfile[] = out.ranked.map((r) => ({
          profileId: r.profile_id,
          score: r.score,
          rationale: r.rationale,
        }));
        for (const r of rerankedHead) {
          rerankedIds.add(r.profileId);
          const existing = deterministicFit.get(r.profileId);
          if (existing) {
            deterministicFit.set(r.profileId, {
              ...existing,
              source: 'llm_rerank',
              score: r.score,
              rationale: r.rationale || existing.rationale,
              scoreBreakdown: { ...existing.scoreBreakdown, total: r.score },
            });
          }
        }
        ranked = [...rerankedHead, ...tail];
      } catch (err) {
        // Re-rank is best-effort: fall back to the deterministic order on any
        // agent failure rather than failing the whole match request.
        logger.warn(
          { event: 'matching.rerankFailed', briefId, err: (err as Error).message },
          'blogger_matcher re-rank failed; using deterministic order',
        );
      }
    }

    // Persist match_result rows for audit (replace prior results for this
    // brief). S6: the deleteMany + createMany run in a SINGLE transaction
    // (array form $transaction is atomic) so a concurrent reader never sees the
    // brief mid-replace with prior rows deleted but new rows not yet written.
    await prisma.$transaction([
      prisma.matchResult.deleteMany({ where: { briefId } }),
      ...(ranked.length > 0
        ? [
            prisma.matchResult.createMany({
              data: ranked.map((r) => ({
                briefId,
                profileId: r.profileId,
                score: r.score,
                rationale: r.rationale,
                rerankedByLlm: rerankedIds.has(r.profileId),
                fitSignals: fitSignalsForPersist(
                  deterministicFit.get(r.profileId) ?? {
                    score: r.score,
                    source: rerankedIds.has(r.profileId) ? 'llm_rerank' : 'deterministic',
                    rationale: r.rationale,
                    positiveSignals: [],
                    gaps: ['fit metadata unavailable'],
                    evidencePostIds: [],
                    scoreBreakdown: { total: r.score },
                  },
                ) as never,
                evidencePostIds: deterministicFit.get(r.profileId)?.evidencePostIds ?? [],
              })),
            }),
          ]
        : []),
    ]);

    // Build the response (candidates joined with their profiles).
    const candidates = ranked
      .map((r) => {
        const p = profileById.get(r.profileId);
        if (!p) return null;
        return {
          profile: {
            ...serializeProfile(p),
            topPostsPreview: rankPostInsightsForPreview(postsByProfile.get(r.profileId) ?? [], {
              avgViews: p.avgViews ?? null,
            }),
          },
          score: r.score,
          rationale: r.rationale,
          rerankedByLlm: rerankedIds.has(r.profileId),
          fit: deterministicFit.get(r.profileId)
            ? {
                score: deterministicFit.get(r.profileId)!.score,
                rationale: deterministicFit.get(r.profileId)!.rationale,
                positiveSignals: deterministicFit.get(r.profileId)!.positiveSignals,
                gaps: deterministicFit.get(r.profileId)!.gaps,
                evidencePostIds: deterministicFit.get(r.profileId)!.evidencePostIds,
                scoreBreakdown: deterministicFit.get(r.profileId)!.scoreBreakdown,
              }
            : undefined,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return { briefId, candidates };
  },
};

/** Serialize a DB profile to the BloggerProfile API shape. */
function serializeProfile(p: DbBloggerProfile) {
  return {
    id: p.id,
    channelId: p.channelId ?? null,
    topics: p.topics,
    languages: p.languages,
    formats: p.formats,
    audience: parseAudience(p.audience),
    rateCards: parseRateCards(p.rateCards),
    placementOffers: parsePlacementOffers((p as { placementOffers?: unknown }).placementOffers),
    reach: p.reach ?? null,
    avgViews: p.avgViews ?? null,
    capturedAt: p.capturedAt ? p.capturedAt.toISOString() : null,
    postInsightRefreshStatus: p.postInsightRefreshStatus,
    postInsightRefreshError: p.postInsightRefreshError ?? null,
    postInsightRefreshedAt: p.postInsightRefreshedAt ? p.postInsightRefreshedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
