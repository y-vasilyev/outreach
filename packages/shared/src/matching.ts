import type { AdBrief } from './schemas/matching.js';
import type { Audience, BloggerProfile, RateCard } from './schemas/blogger-profile.js';
import type { PlacementOffer } from './schemas/placement-offer.js';
import { getOfferAttribute, getOfferAttributes } from './placement-offers.js';

/**
 * Pure blogger-matching engine (agency-sourcing-matching M7, design D6).
 *
 * Two-stage filter→score over the catalog, kept side-effect-free so it's
 * trivially unit-testable and deterministic:
 *
 *   1. `prefilter`  — cheap deterministic exclusion: a profile must have at
 *      least one matchable topic / geo / format and (when the brief carries a
 *      budget) a relevant rate card that fits the budget. Clearly-irrelevant
 *      profiles drop out before any scoring.
 *   2. `scoreProfile` — produces a score in [0,1] from topic/geo/format/budget
 *      sub-scores plus a human-readable rationale.
 *   3. `rankProfiles` — prefilters, scores, and orders the survivors.
 *
 * The optional LLM re-rank (BloggerMatcher agent) operates on the top N of the
 * deterministic ranking; the engine here never calls an LLM.
 */

/**
 * A profile narrowed to the fields matching reads (subset of BloggerProfile).
 *
 * `placementOffers` is the structured commercial view (entity-style-rate-cards).
 * It is optional: when absent — or when the caller passes `useStructuredOffers:
 * false` (the `structured_placement_offers` flag off) — scoring uses only the
 * legacy `rateCards`/`formats`, byte-identical to the pre-change behavior.
 */
export type MatchableProfile = Pick<
  BloggerProfile,
  'id' | 'topics' | 'languages' | 'formats' | 'audience' | 'rateCards' | 'reach' | 'avgViews'
> & {
  placementOffers?: PlacementOffer[];
};

/**
 * Matcher options. `useStructuredOffers` is the resolved value of the
 * `structured_placement_offers` feature flag, passed in by the (impure) service
 * — this module never reads flags/DB/IO. When false, the structured path is
 * inert and the engine behaves exactly as before. Default false (fail-safe).
 */
export interface MatchOptions {
  useStructuredOffers?: boolean;
}

export interface ScoredProfile {
  profileId: string;
  score: number;
  rationale: string;
}

/** Weights for the deterministic sub-scores; sum is normalised at use. */
const WEIGHTS = {
  topic: 0.4,
  geo: 0.25,
  format: 0.2,
  budget: 0.15,
} as const;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function tokenize(s: string): string[] {
  return norm(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/** Does `haystack` (a token set) contain `needle` (substring-aware)? */
function fuzzyHas(haystackTokens: Set<string>, needle: string): boolean {
  const n = norm(needle);
  if (!n) return false;
  if (haystackTokens.has(n)) return true;
  // substring either direction (e.g. brief "крипта" vs profile topic "криптовалюта")
  for (const t of haystackTokens) {
    if (t.includes(n) || n.includes(t)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Topic                                                              */
/* ------------------------------------------------------------------ */

export function topicScore(brief: AdBrief, profile: MatchableProfile): { score: number; matched: string[] } {
  const briefTerms = [brief.topic, ...tokenize(brief.topic)].filter(Boolean);
  if (briefTerms.length === 0) return { score: 0, matched: [] };
  const profileTokens = new Set<string>();
  for (const t of profile.topics) {
    profileTokens.add(norm(t));
    for (const tok of tokenize(t)) profileTokens.add(tok);
  }
  const matched: string[] = [];
  for (const term of new Set(briefTerms.map(norm))) {
    if (fuzzyHas(profileTokens, term)) matched.push(term);
  }
  // Whole-topic match dominates; token overlap contributes partially.
  const wholeMatch = profile.topics.some((t) => fuzzyHas(new Set([norm(brief.topic)]), t) || fuzzyHas(profileTokens, brief.topic));
  const tokenTerms = tokenize(brief.topic);
  const ratio = tokenTerms.length > 0
    ? tokenTerms.filter((t) => fuzzyHas(profileTokens, t)).length / tokenTerms.length
    : 0;
  const score = wholeMatch ? Math.max(0.7, ratio) : ratio * 0.8;
  return { score: Math.min(1, score), matched };
}

/* ------------------------------------------------------------------ */
/* Geo                                                                */
/* ------------------------------------------------------------------ */

function profileGeoKeys(audience: Audience): Set<string> {
  const out = new Set<string>();
  const geo = (audience as { geo?: Record<string, number> } | undefined)?.geo ?? {};
  for (const k of Object.keys(geo)) {
    out.add(norm(k));
    for (const tok of tokenize(k)) out.add(tok);
  }
  return out;
}

export function geoScore(brief: AdBrief, profile: MatchableProfile): { score: number; matched: string[]; applicable: boolean } {
  if (brief.geo.length === 0) return { score: 1, matched: [], applicable: false };
  const keys = profileGeoKeys(profile.audience);
  if (keys.size === 0) return { score: 0, matched: [], applicable: true };
  const matched = brief.geo.filter((g) => fuzzyHas(keys, g)).map(norm);
  const score = matched.length / brief.geo.length;
  return { score, matched, applicable: true };
}

/* ------------------------------------------------------------------ */
/* Format                                                             */
/* ------------------------------------------------------------------ */

function profileFormatKeys(profile: MatchableProfile): Set<string> {
  const out = new Set<string>();
  for (const f of profile.formats) {
    out.add(norm(f));
    for (const tok of tokenize(f)) out.add(tok);
  }
  for (const rc of profile.rateCards) {
    out.add(norm(rc.format));
    for (const tok of tokenize(rc.format)) out.add(tok);
  }
  return out;
}

export function formatScore(brief: AdBrief, profile: MatchableProfile): { score: number; matched: string[]; applicable: boolean } {
  if (brief.formats.length === 0) return { score: 1, matched: [], applicable: false };
  const keys = profileFormatKeys(profile);
  if (keys.size === 0) return { score: 0, matched: [], applicable: true };
  const matched = brief.formats.filter((f) => fuzzyHas(keys, f)).map(norm);
  const score = matched.length / brief.formats.length;
  return { score, matched, applicable: true };
}

/* ------------------------------------------------------------------ */
/* Budget                                                             */
/* ------------------------------------------------------------------ */

/**
 * Rate cards relevant to the brief: those whose format the brief asked for.
 * When the brief specifies formats but the profile has NO rate card for any of
 * them, this returns an empty list — NOT all rate cards (S5). Budgeting against
 * an unrelated format's price would wrongly include or exclude a profile; the
 * format-relevance check (not budget) governs that case. When the brief
 * specifies no formats, all rate cards are relevant.
 */
export function relevantRates(brief: AdBrief, profile: MatchableProfile): RateCard[] {
  if (brief.formats.length === 0) return profile.rateCards;
  const wanted = new Set(brief.formats.map(norm));
  return profile.rateCards.filter((rc) => {
    const fk = new Set<string>([norm(rc.format), ...tokenize(rc.format)]);
    for (const w of wanted) if (fuzzyHas(fk, w)) return true;
    return false;
  });
}

export function minRelevantRate(brief: AdBrief, profile: MatchableProfile): number | undefined {
  const rates = relevantRates(brief, profile)
    .map((rc) => rc.price)
    .filter((p) => typeof p === 'number' && Number.isFinite(p) && p > 0);
  return rates.length > 0 ? Math.min(...rates) : undefined;
}

export function budgetScore(
  brief: AdBrief,
  profile: MatchableProfile,
): { score: number; applicable: boolean; fits: boolean; minRate?: number } {
  if (brief.budget === null || brief.budget === undefined) {
    return { score: 0.5, applicable: false, fits: true };
  }
  const minRate = minRelevantRate(brief, profile);
  if (minRate === undefined) {
    // Budget set but no known rate card → can't confirm fit; neutral-low.
    return { score: 0.5, applicable: true, fits: true };
  }
  if (minRate > brief.budget) {
    return { score: 0, applicable: true, fits: false, minRate };
  }
  // Cheaper relative to budget scores higher (more headroom), capped.
  const ratio = minRate / brief.budget; // (0, 1]
  const score = Math.max(0.5, 1 - ratio * 0.5); // 0.5..1
  return { score, applicable: true, fits: true, minRate };
}

/* ------------------------------------------------------------------ */
/* Structured placement offers (entity-style-rate-cards)              */
/* ------------------------------------------------------------------ */

/**
 * When `useStructuredOffers` is on AND the profile carries at least one
 * structured offer, format/budget fit is evaluated from the offers (which keep
 * platform/kind/duration/deletion-policy/included-deliverables/tax/price as
 * typed terms) instead of the flattened legacy `rateCards`. The legacy path is
 * used otherwise. This is the single switch that the rest of the engine reads.
 */
function useOffers(profile: MatchableProfile, opts: MatchOptions): boolean {
  return opts.useStructuredOffers === true && (profile.placementOffers?.length ?? 0) > 0;
}

/** Localized labels for placement terms surfaced in the rationale. */
const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'telegram',
  youtube: 'youtube',
  instagram: 'instagram',
  vk: 'vk',
  tiktok: 'tiktok',
};
const KIND_LABEL: Record<string, string> = {
  post: 'пост',
  story: 'сторис',
  reels: 'reels',
  shorts: 'shorts',
  video: 'видео',
  integration: 'интеграция',
  offsite_review: 'выездной обзор',
  package: 'пакет',
  other: 'другое',
};
const DURATION_LABEL: Record<string, string> = {
  day: 'сутки',
  week: 'неделя',
  month: 'месяц',
  permanent: 'бессрочно',
};

/** Rank of how "long-lived" a placement is; higher = stays longer. */
const DURATION_RANK: Record<string, number> = { day: 1, week: 2, month: 3, permanent: 4 };
/** Rank assigned to a permanent (never-deleted) placement. */
const PERMANENT_RANK = 4;

/**
 * Desired placement terms parsed from the brief. The brief has no dedicated
 * structured fields, so we read them out of `formats[]` + `notes` (tokens like
 * "telegram", "пост/post", "месяц/month/long", "без удаления/permanent",
 * "анонс/event/обзор" deliverables). Absent terms don't constrain.
 */
export interface BriefPlacementWants {
  platform?: string;
  kind?: string;
  /** Minimum required lifetime rank (from DURATION_RANK); undefined = any. */
  minDurationRank?: number;
  /** True when the brief wants the post to stay (not deleted). */
  wantsPermanent: boolean;
  /** Free deliverable keywords the brief wants included (e.g. анонс, обзор). */
  deliverables: string[];
}

const PLATFORM_SYNONYMS: Record<string, string> = {
  telegram: 'telegram', tg: 'telegram', телеграм: 'telegram', телега: 'telegram',
  youtube: 'youtube', ютуб: 'youtube', yt: 'youtube',
  instagram: 'instagram', инстаграм: 'instagram', инста: 'instagram', ig: 'instagram',
  vk: 'vk', вконтакте: 'vk',
  tiktok: 'tiktok', тикток: 'tiktok',
};
const KIND_SYNONYMS: Record<string, string> = {
  post: 'post', пост: 'post', posts: 'post', посты: 'post',
  story: 'story', stories: 'story', сторис: 'story', сторителлинг: 'story',
  reels: 'reels', reel: 'reels', рилс: 'reels',
  shorts: 'shorts', short: 'shorts', шортс: 'shorts',
  video: 'video', видео: 'video', ролик: 'video',
  integration: 'integration', интеграция: 'integration',
  review: 'offsite_review', обзор: 'offsite_review',
};
const DURATION_SYNONYMS: Record<string, string> = {
  day: 'day', сутки: 'day', день: 'day', '24': 'day',
  week: 'week', неделя: 'week',
  month: 'month', месяц: 'month', longterm: 'month', 'long-lived': 'month', longlived: 'month', long: 'month', надолго: 'month', долго: 'month',
  permanent: 'permanent', бессрочно: 'permanent', навсегда: 'permanent', forever: 'permanent',
};
/** Deliverable cue tokens → canonical deliverable label kept for matching. */
const DELIVERABLE_SYNONYMS: Record<string, string> = {
  анонс: 'анонс', announce: 'анонс', announcement: 'анонс', event: 'анонс', ивент: 'анонс', мероприятие: 'анонс',
  обзор: 'обзор', review: 'обзор',
  упоминание: 'упоминание', mention: 'упоминание',
  закреп: 'закреп', pin: 'закреп', pinned: 'закреп',
};

export function parseBriefPlacementWants(brief: AdBrief): BriefPlacementWants {
  const tokens = new Set<string>();
  for (const f of brief.formats) for (const t of [norm(f), ...tokenize(f)]) tokens.add(t);
  for (const t of tokenize(brief.notes ?? '')) tokens.add(t);

  let platform: string | undefined;
  let kind: string | undefined;
  let minDurationRank: number | undefined;
  let wantsPermanent = false;
  const deliverables = new Set<string>();

  for (const t of tokens) {
    if (!platform && PLATFORM_SYNONYMS[t]) platform = PLATFORM_SYNONYMS[t];
    if (!kind && KIND_SYNONYMS[t]) kind = KIND_SYNONYMS[t];
    const dur = DURATION_SYNONYMS[t];
    if (dur) {
      const rank = DURATION_RANK[dur];
      if (rank !== undefined && (minDurationRank === undefined || rank > minDurationRank)) {
        minDurationRank = rank;
      }
      if (dur === 'permanent') wantsPermanent = true;
    }
    if (DELIVERABLE_SYNONYMS[t]) deliverables.add(DELIVERABLE_SYNONYMS[t]);
  }
  // "без удаления" / "not deleted" → permanent intent even without a duration token.
  const joined = [...tokens].join(' ');
  if (/удалени|delet/.test(joined) && /без|no|not/.test(joined)) wantsPermanent = true;

  return { platform, kind, minDurationRank, wantsPermanent, deliverables: [...deliverables] };
}

/** Normalized term view of one offer used for scoring + rationale. */
interface OfferTerms {
  platform: string | null;
  kind: string;
  durationRank?: number;
  durationLabel?: string;
  isPermanent: boolean;
  deliverables: string[];
  price: number | null;
  /** All stated taxes (an offer can carry stacked taxes, e.g. ИП 8% + реклама 3%). */
  tax: string[];
}

function readOfferTerms(offer: PlacementOffer): OfferTerms {
  const platform = offer.platform ? norm(offer.platform) : null;
  const kind = norm(offer.kind);
  const durRaw = getOfferAttribute(offer, 'duration');
  const durKey = typeof durRaw === 'string' ? norm(durRaw) : undefined;
  const durationRank = durKey ? DURATION_RANK[durKey] : undefined;
  const deletePolicy = getOfferAttribute(offer, 'delete_policy');
  const isPermanent =
    durKey === 'permanent' || (typeof deletePolicy === 'string' && norm(deletePolicy) === 'permanent');
  const includesRaw = getOfferAttribute(offer, 'includes');
  const deliverables: string[] = [];
  if (Array.isArray(includesRaw)) {
    for (const x of includesRaw) {
      for (const tok of tokenize(String(x))) {
        const canon = DELIVERABLE_SYNONYMS[tok];
        if (canon && !deliverables.includes(canon)) deliverables.push(canon);
      }
    }
  }
  const tax = getOfferAttributes(offer, 'tax')
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return {
    platform,
    kind,
    durationRank,
    durationLabel: durKey,
    isPermanent,
    deliverables,
    price: typeof offer.price === 'number' && Number.isFinite(offer.price) ? offer.price : null,
    tax,
  };
}

interface StructuredOfferScore {
  /** Fit in [0,1] of this single offer vs the brief's wants. */
  fit: number;
  terms: OfferTerms;
  /** True when the offer is at least kind/platform-compatible with the brief. */
  relevant: boolean;
}

/**
 * Score a single offer against the brief's wants. Platform/kind drive
 * relevance; duration/deletion/deliverables/tax refine the fit so a long-lived
 * post outranks a one-day post for a brief wanting a long-lived placement.
 */
function scoreOffer(wants: BriefPlacementWants, terms: OfferTerms): StructuredOfferScore {
  let relevant = true;
  let bonus = 0;
  let parts = 0;

  if (wants.platform) {
    const ok = terms.platform === wants.platform || terms.platform === null;
    if (terms.platform !== null) {
      parts++;
      if (terms.platform === wants.platform) bonus++;
      else relevant = false;
    }
    if (!ok) relevant = false;
  }
  if (wants.kind) {
    parts++;
    if (terms.kind === wants.kind) bonus++;
    else relevant = false;
  }
  if (wants.minDurationRank !== undefined) {
    parts++;
    const rank = terms.isPermanent ? PERMANENT_RANK : terms.durationRank;
    if (rank !== undefined && rank >= wants.minDurationRank) bonus++;
    // shorter-than-wanted offer: relevant but penalized (no bonus).
  }
  if (wants.wantsPermanent) {
    parts++;
    if (terms.isPermanent) bonus++;
  }
  if (wants.deliverables.length > 0) {
    parts++;
    const covered = wants.deliverables.filter((d) => terms.deliverables.includes(d)).length;
    bonus += covered / wants.deliverables.length;
  }

  const fit = parts === 0 ? (relevant ? 1 : 0) : (relevant ? bonus / parts : 0);
  return { fit: Math.max(0, Math.min(1, fit)), terms, relevant };
}

export interface StructuredPlacementResult {
  /** Format-dimension score in [0,1]. */
  formatScore: number;
  /** True when at least one offer is relevant to the brief's platform/kind. */
  hasRelevant: boolean;
  /** The best-fitting relevant offer's terms (for rationale + budget). */
  best?: OfferTerms;
  /** Human-readable Russian summary of `best`'s terms (empty when none). */
  bestSummary: string;
  /** Relevant offers' prices for the budget check. */
  relevantPrices: number[];
}

/**
 * Evaluate a profile's structured offers against the brief. The chosen "best"
 * offer is the most-fitting relevant one (ties broken by longer lifetime, then
 * lower price), which is what the rationale cites and budget scores against.
 */
export function structuredPlacementScore(
  brief: AdBrief,
  offers: PlacementOffer[],
): StructuredPlacementResult {
  const wants = parseBriefPlacementWants(brief);
  const scored = offers.map((o) => scoreOffer(wants, readOfferTerms(o)));
  const relevant = scored.filter((s) => s.relevant);
  const pool = relevant.length > 0 ? relevant : scored;

  let best: StructuredOfferScore | undefined;
  for (const s of pool) {
    if (!best) { best = s; continue; }
    if (s.fit !== best.fit) { if (s.fit > best.fit) best = s; continue; }
    const sd = s.terms.isPermanent ? PERMANENT_RANK : (s.terms.durationRank ?? 0);
    const bd = best.terms.isPermanent ? PERMANENT_RANK : (best.terms.durationRank ?? 0);
    if (sd !== bd) { if (sd > bd) best = s; continue; }
    const sp = s.terms.price ?? Infinity;
    const bp = best.terms.price ?? Infinity;
    if (sp < bp) best = s;
  }

  const relevantPrices = relevant
    .map((s) => s.terms.price)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0);

  return {
    formatScore: best ? best.fit : 0,
    hasRelevant: relevant.length > 0,
    best: best?.terms,
    bestSummary: best ? describeOfferTerms(best.terms) : '',
    relevantPrices,
  };
}

/** Human-readable Russian summary of an offer's placement terms (for rationale). */
function describeOfferTerms(terms: OfferTerms): string {
  const bits: string[] = [];
  if (terms.platform) bits.push(PLATFORM_LABEL[terms.platform] ?? terms.platform);
  bits.push(KIND_LABEL[terms.kind] ?? terms.kind);
  if (terms.isPermanent) bits.push('бессрочно');
  else if (terms.durationLabel) bits.push(DURATION_LABEL[terms.durationLabel] ?? terms.durationLabel);
  if (terms.deliverables.length > 0) bits.push(`включает: ${terms.deliverables.join(', ')}`);
  for (const t of terms.tax) bits.push(t);
  return bits.join(', ');
}

/* ------------------------------------------------------------------ */
/* Prefilter                                                          */
/* ------------------------------------------------------------------ */

export interface PrefilterReason {
  profileId: string;
  reason: string;
}

/**
 * Deterministic exclusion. A profile is excluded when, for any dimension the
 * brief constrains, it has NO overlap at all — or when its cheapest relevant
 * rate exceeds the budget. Dimensions the brief leaves empty don't constrain.
 */
export function isShortlisted(
  brief: AdBrief,
  profile: MatchableProfile,
  opts: MatchOptions = {},
): { ok: boolean; reason?: string } {
  // Topic: brief always has a topic. Require at least a partial overlap.
  const topic = topicScore(brief, profile);
  if (topic.score <= 0) return { ok: false, reason: `no topic overlap (brief="${brief.topic}")` };

  if (brief.geo.length > 0) {
    const geo = geoScore(brief, profile);
    if (geo.applicable && geo.score <= 0) {
      return { ok: false, reason: `geo mismatch (brief=${brief.geo.join('/')})` };
    }
  }

  if (useOffers(profile, opts)) {
    // Structured path: format relevance comes from offers, budget from offer
    // prices for relevant offers. Both gates mirror the legacy semantics.
    const structured = structuredPlacementScore(brief, profile.placementOffers ?? []);
    if (brief.formats.length > 0 && !structured.hasRelevant) {
      return { ok: false, reason: `format unavailable (brief=${brief.formats.join('/')})` };
    }
    if (brief.budget !== null && brief.budget !== undefined && structured.relevantPrices.length > 0) {
      const minRate = Math.min(...structured.relevantPrices);
      if (minRate > brief.budget) {
        return { ok: false, reason: `over budget (min rate ${minRate} > budget ${brief.budget})` };
      }
    }
    return { ok: true };
  }

  if (brief.formats.length > 0) {
    const fmt = formatScore(brief, profile);
    if (fmt.applicable && fmt.score <= 0) {
      return { ok: false, reason: `format unavailable (brief=${brief.formats.join('/')})` };
    }
  }

  if (brief.budget !== null && brief.budget !== undefined) {
    const budget = budgetScore(brief, profile);
    if (budget.applicable && !budget.fits) {
      return {
        ok: false,
        reason: `over budget (min rate ${budget.minRate} > budget ${brief.budget})`,
      };
    }
  }

  return { ok: true };
}

export function prefilter(
  brief: AdBrief,
  profiles: MatchableProfile[],
  opts: MatchOptions = {},
): MatchableProfile[] {
  return profiles.filter((p) => isShortlisted(brief, p, opts).ok);
}

/* ------------------------------------------------------------------ */
/* Score + rationale                                                  */
/* ------------------------------------------------------------------ */

export function scoreProfile(
  brief: AdBrief,
  profile: MatchableProfile,
  opts: MatchOptions = {},
): ScoredProfile {
  const topic = topicScore(brief, profile);
  const geo = geoScore(brief, profile);

  const parts: string[] = [];
  parts.push(
    topic.matched.length > 0
      ? `тема: совпадение по ${topic.matched.join(', ')}`
      : `тема: слабое совпадение с «${brief.topic}»`,
  );
  if (geo.applicable) {
    parts.push(geo.matched.length > 0 ? `гео: ${geo.matched.join(', ')}` : 'гео: нет пересечения');
  }

  // Format + budget sub-scores. The structured path (offers present + flag on)
  // replaces both with offer-derived values and cites the placement terms in
  // the rationale; otherwise the legacy rate-card path runs unchanged.
  let formatSub: number;
  let budgetSub: number;

  if (useOffers(profile, opts)) {
    const structured = structuredPlacementScore(brief, profile.placementOffers ?? []);
    formatSub = brief.formats.length === 0 ? 1 : structured.formatScore;

    // Budget against the relevant offers' prices, mirroring legacy budgetScore.
    if (brief.budget === null || brief.budget === undefined) {
      budgetSub = 0.5;
    } else if (structured.relevantPrices.length === 0) {
      budgetSub = 0.5;
    } else {
      const minRate = Math.min(...structured.relevantPrices);
      if (minRate > brief.budget) budgetSub = 0;
      else budgetSub = Math.max(0.5, 1 - (minRate / brief.budget) * 0.5);
    }

    if (brief.formats.length > 0) {
      parts.push(
        structured.best
          ? `условия: ${structured.bestSummary}`
          : 'условия: не предлагает запрошенное размещение',
      );
    } else if (structured.best) {
      parts.push(`условия: ${structured.bestSummary}`);
    }
    if (brief.budget !== null && brief.budget !== undefined) {
      if (structured.relevantPrices.length > 0) {
        const minRate = Math.min(...structured.relevantPrices);
        parts.push(
          minRate <= brief.budget
            ? `бюджет: прайс ${minRate} ≤ ${brief.budget} (вписывается)`
            : `бюджет: прайс ${minRate} > ${brief.budget} (превышает)`,
        );
      } else {
        parts.push('бюджет: прайс неизвестен');
      }
    }
  } else {
    const fmt = formatScore(brief, profile);
    const budget = budgetScore(brief, profile);
    formatSub = fmt.score;
    budgetSub = budget.score;
    if (fmt.applicable) {
      parts.push(fmt.matched.length > 0 ? `форматы: ${fmt.matched.join(', ')}` : 'форматы: не предлагает запрошенное');
    }
    if (budget.applicable) {
      if (budget.minRate !== undefined) {
        parts.push(
          budget.fits
            ? `бюджет: прайс ${budget.minRate} ≤ ${brief.budget} (вписывается)`
            : `бюджет: прайс ${budget.minRate} > ${brief.budget} (превышает)`,
        );
      } else {
        parts.push('бюджет: прайс неизвестен');
      }
    }
  }

  const raw =
    WEIGHTS.topic * topic.score +
    WEIGHTS.geo * geo.score +
    WEIGHTS.format * formatSub +
    WEIGHTS.budget * budgetSub;
  // WEIGHTS sum to 1, so raw is already in [0,1].
  const score = Math.max(0, Math.min(1, raw));

  parts.push(`итог ${(score * 100).toFixed(0)}%`);

  return { profileId: profile.id, score, rationale: parts.join('; ') };
}

/**
 * Prefilter → score → order. Ties broken by reach (higher first) then id for
 * determinism. Returns scored survivors only.
 */
export function rankProfiles(
  brief: AdBrief,
  profiles: MatchableProfile[],
  opts: MatchOptions = {},
): ScoredProfile[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const shortlisted = prefilter(brief, profiles, opts);
  const scored = shortlisted.map((p) => scoreProfile(brief, p, opts));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = byId.get(a.profileId)?.reach ?? 0;
    const rb = byId.get(b.profileId)?.reach ?? 0;
    if (rb !== ra) return rb - ra;
    return a.profileId.localeCompare(b.profileId);
  });
  return scored;
}
