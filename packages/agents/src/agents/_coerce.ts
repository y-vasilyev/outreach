/**
 * Coercers for LLM JSON outputs.
 *
 * Two tiers, on purpose:
 *
 * 1. **Soft fields** — `tone`, `length`, `urgency`, `language`, `intent_target`.
 *    These are labels on otherwise valid output (analytics / UI / advisory).
 *    A wrong label is recoverable; a failed turn isn't. We apply
 *    `z.catch(<safe-default>)` so the agent never dies over a label.
 *    Vocabulary the LLM should aim for is enumerated automatically in the
 *    system prompt by `renderSchemaHints` — no substring matchers needed.
 *
 * 2. **Hard fields** — `HandoffAction`, `confidence`, `risk_score`, IntScore.
 *    These change system behaviour (routing, gating, scoring). They stay
 *    strict; a parse failure triggers the repair-loop in
 *    `wrap.completeJson`. For `HandoffAction` we keep substring synonyms
 *    because the consequences of falling through are highest (operator
 *    not getting paged), and over-triggering `operator_now` is the safest
 *    failure mode.
 */

import { z } from 'zod';

export const LanguageEnum = z.enum(['ru', 'en', 'other']);
// Soft field — language label. Schema-hints in the system prompt enumerate
// the legal tokens; any non-matching value falls back to 'other'.
export const LanguageCoerced = LanguageEnum.catch('other');

export const ToneEnum = z.enum(['formal', 'casual', 'edgy', 'neutral']);
// Soft field — descriptor on channel analysis. 'neutral' is the safe default.
export const ToneCoerced = ToneEnum.catch('neutral');

/**
 * Numeric confidence 0..1. Accepts qualitative strings ("low"/"medium"/"high"
 * or their Russian equivalents), percentages ("85%" or 85), and naturally
 * any number in range. Out-of-range numbers are clamped.
 */
export const ConfidenceCoerced = z.preprocess((v) => {
  const n = qualitativeToNumber(v);
  if (n === undefined) return v;
  return Math.max(0, Math.min(1, n));
}, z.number().min(0).max(1));

/**
 * Risk score 0..1. Models often emit percentages (0..100). Numbers >1 and
 * ≤100 are interpreted as percentages and divided by 100.
 */
export const RiskScoreCoerced = z.preprocess((v) => {
  const n = qualitativeToNumber(v);
  if (n === undefined) return v;
  // 0..1 already
  if (n >= 0 && n <= 1) return n;
  // Looks like a 0..100 percentage
  if (n > 1 && n <= 100) return n / 100;
  // Negative or absurdly high — clamp to bounds
  return Math.max(0, Math.min(1, n));
}, z.number().min(0).max(1));

/**
 * `length` is a categorical bucket but the LLM still occasionally emits a
 * raw character count. We keep the number→bucket mapping as a preprocess
 * (it's a deterministic translation, not a vocabulary guess) and wrap the
 * whole thing in `.catch('medium')` so an unrecognised label never kills
 * the turn. 'medium' is the neutral default for ranking.
 */
export const LengthEnum = z.enum(['short', 'medium', 'long']);

export const LengthCoerced = z
  .preprocess((v) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v < 120) return 'short';
      if (v < 300) return 'medium';
      return 'long';
    }
    return v;
  }, LengthEnum)
  .catch('medium');

/**
 * Handoff action enum + tolerant coercer. The LLM tends to invent its own
 * action vocabulary (`continue_dialog`, `proceed`, `escalate`, `human` …)
 * even when the system prompt lists the exact tokens. Map common
 * synonyms to the canonical three so a perfectly reasonable response
 * doesn't waste a retry.
 */
export const HandoffActionEnum = z.enum(['ai_continue', 'ai_suggest_only', 'operator_now']);

export const HandoffActionCoerced = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase().trim();
  if (s === 'ai_continue' || s === 'ai_suggest_only' || s === 'operator_now') return s;
  // Operator escalation synonyms first — they're the safest to over-trigger.
  if (
    s.includes('operator') ||
    s.includes('human') ||
    s.includes('escalat') ||
    s.includes('handoff') ||
    s.includes('hand off') ||
    s.includes('handover') ||
    s.includes('операт') ||
    s.includes('передат') ||
    s.includes('эскал') ||
    s.includes('челов')
  ) {
    return 'operator_now';
  }
  // Suggestion-only synonyms.
  if (
    s.includes('suggest') ||
    s.includes('assist') ||
    s.includes('подсказ') ||
    s.includes('assisted') ||
    s.includes('hint')
  ) {
    return 'ai_suggest_only';
  }
  // Anything that reads as "keep going" or "continue" defaults to ai_continue.
  if (
    s.includes('continue') ||
    s.includes('proceed') ||
    s.includes('keep') ||
    s === 'ai' ||
    s === 'auto' ||
    s.includes('продолж') ||
    s.includes('диалог') ||
    s.includes('авто')
  ) {
    return 'ai_continue';
  }
  return v;
}, HandoffActionEnum);

/**
 * Urgency is a soft field — it bumps an alert badge in the UI but doesn't
 * gate routing (HandoffAction does). Catch unknown values as 'normal' to
 * avoid false-high alarms from creative model vocabulary.
 */
export const UrgencyEnum = z.enum(['low', 'normal', 'high']);
export const UrgencyCoerced = UrgencyEnum.catch('normal');

/**
 * ReplyComposer's `intent_target` is a label on a *suggestion* — the
 * operator doesn't take action on the value, it's metadata for analytics
 * and UI badges. So this is a "soft" field: a wrong label must never fail
 * the whole turn. We use `z.catch('answer_question')` — the safest neutral
 * default that doesn't bias the funnel toward scheduling.
 *
 * Why this matters: previously the schema was strict + had a substring
 * coercer that silently mapped `confirm_meeting` to `schedule_call`. That
 * was bad in two ways: (1) when a synonym wasn't in the table, the entire
 * job died; (2) when it WAS in the table, the rationale said "confirming"
 * but the label said "scheduling" — analytics garbage.
 *
 * `confirm_meeting` is now a first-class value. The repair-loop in
 * wrap.completeJson handles unknown labels by re-prompting once; if even
 * that fails, z.catch swallows it.
 */
export const IntentTargetEnum = z.enum([
  'qualify',
  'schedule_call',
  'confirm_meeting',
  'answer_question',
  'handle_objection',
  'soft_close',
  'small_talk',
]);

export const IntentTargetCoerced = IntentTargetEnum.catch('answer_question');

/**
 * Integer score in `[min..max]`. Accepts qualitative strings (low/medium/
 * high/etc.) and numeric strings; clamps and rounds. Used by quality-review
 * style scoring agents that ask the LLM for a 1..5 rating.
 */
export function IntScoreCoerced(min: number, max: number) {
  return z.preprocess((v) => {
    const span = max - min;
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(min, Math.min(max, Math.round(v)));
    }
    if (typeof v === 'string') {
      const s = v.toLowerCase().trim();
      if (s === 'high' || s === 'высок') return max;
      if (s === 'medium' || s === 'mid' || s === 'mid-range' || s === 'средн') {
        return Math.round(min + span * 0.5);
      }
      if (s === 'low' || s === 'низк') return min;
      const n = Number(s);
      if (Number.isFinite(n)) return Math.max(min, Math.min(max, Math.round(n)));
    }
    return v;
  }, z.number().int().min(min).max(max));
}

// ─── helpers ───

function qualitativeToNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase().trim();
  if (s.endsWith('%')) {
    const n = Number(s.slice(0, -1));
    if (Number.isFinite(n)) return n / 100;
  }
  // English qualitative
  if (s === 'very_high' || s === 'very high') return 0.95;
  if (s === 'high') return 0.85;
  if (s === 'medium' || s === 'med' || s === 'mid') return 0.6;
  if (s === 'low') return 0.3;
  if (s === 'very_low' || s === 'very low') return 0.15;
  if (s === 'none' || s === 'unknown') return 0;
  // Russian qualitative
  if (s.startsWith('очень высок') || s.startsWith('крайне высок')) return 0.95;
  if (s.startsWith('высок')) return 0.85;
  if (s.startsWith('сред')) return 0.6;
  if (s.startsWith('низ')) return 0.3;
  if (s.startsWith('очень низ') || s.startsWith('крайне низ')) return 0.15;
  // Bare numeric string like "0.8" or "85"
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return undefined;
}
