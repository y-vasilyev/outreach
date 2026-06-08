/**
 * Data-collection target field registry (data-collection-hud-target-fields
 * change, Phase 1).
 *
 * One typed source of truth for the agency-sourcing target fields the
 * `DataCollectionPlanner` asks the blogger about. Owns the operator label,
 * the agent-facing description, the deterministic question template, the
 * exact-or-dotted match against `ProfileDataPoint.field`, and the freshness
 * section the HUD reads from `computeProfileFreshness`.
 *
 * Consumers:
 * - `DataCollectionPlanner` reads `description_for_agent` + `question_template`.
 * - `apps/workers/src/queues/agent-run.ts` reads default targets + match keys.
 * - HUD endpoint reads everything to render the right panel.
 * - `GoalFitEvaluator` prompt reads `description_for_agent` so the gate sees
 *   the same target vocabulary the planner uses.
 *
 * Phase 2 (`entity-types-shadow-metadata`) will let admins edit the same
 * fields from the DB; the shape here is intentionally close to `entity_field`
 * so that becomes a clean adapter swap.
 */

import { z } from 'zod';

import {
  classifyProfileField,
  isContributingValue,
  PROFILE_FIELD_TTL_DAYS,
  type ProfileFreshnessCategory,
} from './profile-staleness.js';

const FRESHNESS_SECTIONS = [
  'rateCards',
  'audience',
  'topics',
  'languages',
  'formats',
  'reach',
  'avgViews',
] as const satisfies readonly ProfileFreshnessCategory[];

const DataCollectionTargetZ = z.object({
  /** Stable string key — referenced by `campaign.goal.target_data_points`. */
  key: z.string().min(1),
  /** Operator-facing label shown in the HUD right panel. */
  label: z.string().min(1),
  /** Operator-facing tooltip + composer pre-fill hint. */
  description_for_operator: z.string().min(1),
  /** Agent-facing description fed into the planner's prompt. */
  description_for_agent: z.string().min(1),
  /** Deterministic fallback question used when the planner overrides the LLM's pick. */
  question_template: z.string().min(1),
  /** Which `computeProfileFreshness` section drives this target's `freshness`. */
  freshness_section: z.enum(FRESHNESS_SECTIONS),
  /**
   * `ProfileDataPoint.field` roots that satisfy this target. Matching is
   * exact-or-dotted-subkey: `rate` matches `rate.post`; `audience.geo`
   * matches `audience.geo.ru`. Use `profileFieldMatchesTarget(...)`.
   */
  profile_data_point_keys: z.array(z.string().min(1)).min(1),
  /**
   * No automated extractor writes a satisfying `ProfileDataPoint` for this
   * target. The HUD surfaces it as a manual gap; the planner skips it so
   * `goal_satisfied` is not blocked on an unfillable field.
   */
  manual_only: z.boolean().optional(),
});

export type DataCollectionTarget = z.infer<typeof DataCollectionTargetZ>;

/**
 * Built-in agency-sourcing registry. v1 mirrors today's `QUESTION_TEMPLATES`
 * + `TARGET_FIELD_KEYWORDS` + `AGENCY_DEFAULT_TARGETS` in one place. Adding
 * a new target = add an entry + (if needed) wire an extractor to emit the
 * matching `ProfileDataPoint.field`.
 */
export const DATA_COLLECTION_TARGETS: Record<string, DataCollectionTarget> = {
  rate_card: {
    key: 'rate_card',
    label: 'Прайс по форматам',
    description_for_operator:
      'Стоимость размещения для каждого формата: пост, сторис, рилс/видео и т.д. (например, «сторис 8000, пост 15000»).',
    description_for_agent:
      'Прайс блогера по форматам: пост, сторис, рилс, интеграция. Ищи числа после слов «прайс», «стоимость», названий форматов; принимай «к», «k», «тыс».',
    question_template:
      'Подскажите, пожалуйста, ваш прайс по форматам (пост, сторис и т.д.)?',
    freshness_section: 'rateCards',
    profile_data_point_keys: ['rate'],
  },
  reach: {
    key: 'reach',
    label: 'Охваты / просмотры',
    description_for_operator:
      'Средние охваты или просмотры на пост и на сторис. Помогает оценить аудиторию.',
    description_for_agent:
      'Охваты или просмотры по форматам (пост, сторис, рилс). Принимай средние / медианные числа и шорткаты «к», «k», «тыс».',
    question_template: 'Какие у вас охваты/просмотры на пост и на сторис?',
    freshness_section: 'reach',
    profile_data_point_keys: ['reach', 'views'],
  },
  audience_demographics: {
    key: 'audience_demographics',
    label: 'Демография аудитории',
    description_for_operator:
      'Пол и возрастные доли аудитории (например, «женщины 60%, мужчины 40%, в основном 25–34»).',
    description_for_agent:
      'Демография аудитории: пол и возраст. Принимай проценты или словесные доли. Это НЕ гео — для гео есть отдельная цель.',
    question_template:
      'Расскажете про аудиторию — пол, возраст, основные интересы?',
    freshness_section: 'audience',
    profile_data_point_keys: ['audience.age', 'audience.gender'],
  },
  geo: {
    key: 'geo',
    label: 'География аудитории',
    description_for_operator:
      'Страны и города основной части аудитории (например, «70% Россия, 15% Казахстан»).',
    description_for_agent:
      'География аудитории: страны и крупные города. Принимай доли в процентах. Это НЕ возраст/пол — для них есть audience_demographics.',
    question_template: 'Из каких стран и городов в основном ваша аудитория?',
    freshness_section: 'audience',
    profile_data_point_keys: ['audience.geo'],
  },
  deals_contact: {
    key: 'deals_contact',
    label: 'Контакт для сделок',
    description_for_operator:
      'С кем согласовывать размещение — сам блогер, менеджер, агентство, форма.',
    description_for_agent:
      'Контакт, через который согласуются размещения. На Phase 1 без автоматического экстрактора — этот пункт только для операторской заметки.',
    question_template:
      'С кем лучше обсуждать размещения — с вами напрямую или есть менеджер?',
    // No automated capture path in Phase 1 — see proposal "manual_only".
    // Pick `audience` as a neutral freshness section; manual_only targets
    // never read freshness in practice because no `current` is set from
    // extractor writes.
    freshness_section: 'audience',
    profile_data_point_keys: ['contact'],
    manual_only: true,
  },
};

/** Default agency-sourcing target set when `campaign.goal.target_data_points` is unset. */
export const AGENCY_DEFAULT_TARGET_KEYS: readonly string[] = [
  'rate_card',
  'reach',
  'audience_demographics',
  'geo',
];

/**
 * Campaign type keys for which the data-collection HUD is meaningful (i.e.
 * the ones that actually run the data-collection planner). Any other type —
 * including `custdev` — has no commercial target list, so the HUD endpoint
 * returns `{ campaignTypeKey: null, targets: [] }` rather than falling back
 * to the agency default set (which would surface commercial fields on a
 * non-agency conversation).
 */
export const HUD_SUPPORTED_CAMPAIGN_TYPE_KEYS: readonly string[] = ['agency_sourcing'];

/** Whether the data-collection HUD applies to this campaign type key. */
export function isHudSupportedCampaignType(key: string | null | undefined): boolean {
  return key != null && HUD_SUPPORTED_CAMPAIGN_TYPE_KEYS.includes(key);
}

/** Look up a single target by key. */
export function getTarget(key: string): DataCollectionTarget | undefined {
  return DATA_COLLECTION_TARGETS[key];
}

/**
 * Exact-or-dotted-subkey match between a `ProfileDataPoint.field` and a
 * registry root. `rate` matches `rate.post`; `audience.geo` matches
 * `audience.geo.ru`; `rate` does NOT match `rateLimit`.
 */
export function profileFieldMatchesTarget(
  field: string,
  target: DataCollectionTarget,
): boolean {
  const lf = field.toLowerCase();
  return target.profile_data_point_keys.some(
    (k) => lf === k.toLowerCase() || lf.startsWith(`${k.toLowerCase()}.`),
  );
}

/**
 * Targets that consider this raw `ProfileDataPoint.field` a satisfying
 * observation. Useful when a write needs to fan a single field to every
 * affected target (e.g. emitting the `dataCollectionUpdated` event).
 */
export function targetsForProfileField(field: string): DataCollectionTarget[] {
  const matches: DataCollectionTarget[] = [];
  for (const target of Object.values(DATA_COLLECTION_TARGETS)) {
    if (profileFieldMatchesTarget(field, target)) matches.push(target);
  }
  return matches;
}

interface CampaignLike {
  goal?: unknown;
}

function readGoalTargetKeys(goal: unknown): string[] {
  if (!goal || typeof goal !== 'object') return [];
  const raw = (goal as { target_data_points?: unknown }).target_data_points;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const key = x.trim();
    if (key.length > 0) out.push(key);
  }
  return out;
}

/**
 * Campaign UI historically allowed operators to type concrete
 * `ProfileDataPoint.field` roots such as `rate.post` even though the HUD and
 * planner registry is keyed by target names such as `rate_card`. Accept those
 * field-shaped values as aliases so already-saved campaigns keep resolving
 * without a data migration.
 */
export function resolveTargetForGoalKey(key: string): DataCollectionTarget | undefined {
  const normalized = key.trim();
  if (!normalized) return undefined;

  const exact = getTarget(normalized) ?? getTarget(normalized.toLowerCase());
  if (exact) return exact;

  const matches = Object.values(DATA_COLLECTION_TARGETS).filter((target) =>
    profileFieldMatchesTarget(normalized, target),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Effective HUD targets for a conversation: keys requested by the campaign's
 * `goal.target_data_points` intersected with the registry (so the HUD never
 * surfaces an untyped blob), falling back to the agency default set when
 * the goal carries none. Order follows the campaign's declared order, or the
 * registry's default order on fallback. Unknown keys are dropped.
 *
 * `unknown` callback (optional) is called once per dropped key so callers can
 * log a warning — the helper itself is silent and side-effect free.
 */
export function resolveEffectiveHudTargets(
  campaign: CampaignLike | null | undefined,
  onUnknown?: (key: string) => void,
): DataCollectionTarget[] {
  const declared = readGoalTargetKeys(campaign?.goal);
  const source = declared.length > 0 ? declared : AGENCY_DEFAULT_TARGET_KEYS;
  const seen = new Set<string>();
  const out: DataCollectionTarget[] = [];
  for (const key of source) {
    const t = resolveTargetForGoalKey(key);
    if (!t) {
      if (declared.length > 0 && onUnknown) onUnknown(key);
      continue;
    }
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t);
  }
  return out;
}

/**
 * Effective planner targets: the HUD list minus `manual_only` entries. The
 * planner only asks questions the system can verify it received an answer
 * for; manual fields are operator-only and don't block `goal_satisfied`.
 */
export function resolveEffectivePlannerTargets(
  campaign: CampaignLike | null | undefined,
  onUnknown?: (key: string) => void,
): DataCollectionTarget[] {
  return resolveEffectiveHudTargets(campaign, onUnknown).filter((t) => !t.manual_only);
}

interface SuggestionLike {
  meta?: unknown;
}

/**
 * Read `Suggestion.meta.targetField` with a single typed cast. Returns
 * undefined for missing / non-string values. The persisted key is camelCase
 * (`targetField`); the planner's output uses snake_case (`target_field`)
 * and is normalized by the worker before persistence.
 */
export function getSuggestionTargetField(
  suggestion: SuggestionLike | null | undefined,
): string | undefined {
  const meta = suggestion?.meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const v = (meta as { targetField?: unknown }).targetField;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * One row in the HUD response / one `dataCollectionUpdated` payload's
 * target-specific fields. Kept in shared so the API endpoint and worker
 * emitters compute identical state for a given (target, data points,
 * last-asked-at) input.
 */
export type HudTargetState = 'answered' | 'asked' | 'missing' | 'stale';

export interface HudTargetCurrent {
  value: unknown;
  capturedAt: string;
  sourceMessageId?: string;
  sourceField: string;
}

export interface HudTargetFreshness {
  stale: boolean;
  ageDays: number | null;
}

export interface HudTargetRow {
  key: string;
  label: string;
  description_for_operator: string;
  freshness_section: DataCollectionTarget['freshness_section'];
  manual_only?: boolean;
  state: HudTargetState;
  current?: HudTargetCurrent;
  lastAskedAt?: string;
  freshness?: HudTargetFreshness;
}

export interface HudDataPointInput {
  field: string;
  value: unknown;
  capturedAt: Date | string | null | undefined;
  sourceMessageId?: string | null;
}

/**
 * Subset of a target's matching data points that ALSO satisfy the
 * rollup's usability filter for THEIR OWN classification (numeric for
 * rate/reach/avgViews, non-empty share record for audience, non-empty
 * string list for topics/languages/formats). Mirrors how the rolled-up
 * profile picks contributing values, so the HUD's "answered" agrees
 * with the freshness signal and the planner stops asking for what the
 * rollup actually has.
 *
 * The per-point classification matters because a target like `reach`
 * may legitimately accept both `reach.*` (classifies to `reach`) and
 * `views.*` (classifies to `avgViews`). A `views.avg = 30000` is a
 * usable observation even though it lands in a different freshness
 * section than the target's declared `freshness_section`. The caller
 * gets each point paired with its category so it can apply the right
 * TTL when computing freshness.
 *
 * Returns `[]` for `manual_only` targets — no extractor write ever
 * counts as a usable observation for those (operator-only).
 */
export function findUsableMatchingPoints(
  target: DataCollectionTarget,
  dataPoints: ReadonlyArray<HudDataPointInput>,
): Array<{ point: HudDataPointInput; category: ProfileFreshnessCategory }> {
  if (target.manual_only) return [];
  const out: Array<{ point: HudDataPointInput; category: ProfileFreshnessCategory }> = [];
  for (const dp of dataPoints) {
    if (!profileFieldMatchesTarget(dp.field, target)) continue;
    const category = classifyProfileField(dp.field);
    if (!category) continue;
    if (!isContributingValue(category, dp.value)) continue;
    out.push({ point: dp, category });
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the HUD row for one target from the conversation's matching
 * data points + the most-recent suggestion that asked for it. Caller is
 * responsible for filtering data points to those whose channel/profile
 * scope the target should observe — typically the whole profile.
 *
 * Same function powers `GET /conversations/:id/data-collection` (one call
 * per target) and the `dataCollectionUpdated` WS payload emitted after a
 * `ProfileDataPoint` write or a `Suggestion` create.
 *
 * Semantics (data-collection-hud-target-fields):
 *
 *   - `current` is picked from the USABLE contributing points only (per
 *     per-point classification + the rollup's usability filter). A fresh
 *     non-numeric `rate.post = "договорная"` is NOT current; the latest
 *     numeric `rate.<format>` wins.
 *   - `freshness` is set ONLY when `current` exists. Each point's TTL is
 *     read from its own classification's section TTL, so a `views.avg`
 *     contributing to the `reach` target is judged against the `avgViews`
 *     TTL — matching the rollup's semantics.
 *   - `now` is injectable so tests can pin time without mocking the
 *     module's clock. Production callers use the default (`new Date()`).
 */
export function buildHudTargetRow(
  target: DataCollectionTarget,
  dataPoints: ReadonlyArray<HudDataPointInput>,
  lastAskedAt: Date | string | null | undefined,
  now: Date = new Date(),
): HudTargetRow {
  const lastAskedIso = toIsoString(lastAskedAt);

  if (target.manual_only) {
    return {
      key: target.key,
      label: target.label,
      description_for_operator: target.description_for_operator,
      freshness_section: target.freshness_section,
      manual_only: true,
      state: lastAskedIso ? 'asked' : 'missing',
      ...(lastAskedIso ? { lastAskedAt: lastAskedIso } : {}),
    };
  }

  const usable = findUsableMatchingPoints(target, dataPoints);

  let current: HudTargetCurrent | undefined;
  let freshness: HudTargetFreshness | undefined;

  if (usable.length > 0) {
    // Pick the newest contributing point. Its OWN classification drives
    // the TTL — a `views.avg` contributing to the `reach` target is
    // judged stale against the `avgViews` TTL (same 90d in practice,
    // but the principle stays correct if the helper's TTLs ever
    // diverge).
    const sorted = [...usable].sort(
      (a, b) => toMillis(b.point.capturedAt) - toMillis(a.point.capturedAt),
    );
    const top = sorted[0]!;
    const iso = toIsoString(top.point.capturedAt);
    const capturedMs = toMillis(top.point.capturedAt);
    if (iso && capturedMs > 0) {
      current = {
        value: top.point.value,
        capturedAt: iso,
        sourceField: top.point.field,
        ...(top.point.sourceMessageId ? { sourceMessageId: top.point.sourceMessageId } : {}),
      };
      const ageMs = Math.max(0, now.getTime() - capturedMs);
      const ageDays = Math.floor(ageMs / DAY_MS);
      const ttlMs = PROFILE_FIELD_TTL_DAYS[top.category] * DAY_MS;
      freshness = { stale: ageMs > ttlMs, ageDays };
    }
  }

  let state: HudTargetState;
  if (current) state = freshness?.stale ? 'stale' : 'answered';
  else if (lastAskedIso) state = 'asked';
  else state = 'missing';

  return {
    key: target.key,
    label: target.label,
    description_for_operator: target.description_for_operator,
    freshness_section: target.freshness_section,
    ...(target.manual_only ? { manual_only: true } : {}),
    state,
    ...(current ? { current } : {}),
    ...(lastAskedIso ? { lastAskedAt: lastAskedIso } : {}),
    ...(freshness ? { freshness } : {}),
  };
}

function toMillis(at: Date | string | null | undefined): number {
  if (!at) return 0;
  if (at instanceof Date) return at.getTime();
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
}

function toIsoString(at: Date | string | null | undefined): string | undefined {
  if (!at) return undefined;
  if (at instanceof Date) return at.toISOString();
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * Module-load validation: every entry must satisfy the zod schema and its
 * `freshness_section` must be a known `computeProfileFreshness` section.
 * Throws in CI so a malformed entry fails the build before deploy.
 */
function validateRegistry(): void {
  for (const [key, entry] of Object.entries(DATA_COLLECTION_TARGETS)) {
    const parsed = DataCollectionTargetZ.safeParse(entry);
    if (!parsed.success) {
      throw new Error(
        `data-collection-targets: entry ${key} failed validation: ${parsed.error.message}`,
      );
    }
    if (parsed.data.key !== key) {
      throw new Error(
        `data-collection-targets: entry key mismatch: map key ${key} != entry.key ${parsed.data.key}`,
      );
    }
  }
}

validateRegistry();
