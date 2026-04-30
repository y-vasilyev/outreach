/**
 * Tolerant coercers for LLM JSON outputs.
 *
 * The system prompts ask for a strict shape, but in practice models
 * (especially YandexGPT) return:
 *   - free-form Russian instead of enum tokens (`"русский"` for language,
 *     `"неформальный, личный"` for tone)
 *   - qualitative confidence (`"medium"`/`"high"`) instead of a number
 *   - char counts (`120`) for `length` instead of `'short'/'medium'/'long'`
 *   - risk scores in 0..100 (or even >100) instead of 0..1
 *
 * Wrapping schema fields with these `z.preprocess(...)` helpers normalises
 * those before validation so a perfectly serviceable answer doesn't waste a
 * full retry cycle. They never *invent* values — they only translate clear
 * synonyms; anything ambiguous falls through to Zod and surfaces as a real
 * validation error.
 */

import { z } from 'zod';

export const LanguageEnum = z.enum(['ru', 'en', 'other']);

export const LanguageCoerced = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase().trim();
  if (s === 'ru' || s === 'en' || s === 'other') return s;
  if (s.startsWith('ru') || s.includes('русск') || s.includes('rus')) return 'ru';
  if (s.startsWith('en') || s.includes('англ') || s.includes('eng')) return 'en';
  return 'other';
}, LanguageEnum);

export const ToneEnum = z.enum(['formal', 'casual', 'edgy', 'neutral']);

export const ToneCoerced = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase();
  if (s === 'formal' || s === 'casual' || s === 'edgy' || s === 'neutral') return s;
  // Order matters: check «неформ» before «форм» so we don't tag an
  // informal Russian description as formal.
  if (s.includes('неформ') || s.includes('информ') || s.includes('casual') || s.includes('личн') || s.includes('дружел') || s.includes('тёпл') || s.includes('тепл'))
    return 'casual';
  if (s.includes('форм') || s.includes('официал') || s.includes('строг'))
    return 'formal';
  if (s.includes('резк') || s.includes('агрес') || s.includes('edgy') || s.includes('сарказ') || s.includes('провок'))
    return 'edgy';
  return 'neutral';
}, ToneEnum);

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
 * `length` is a categorical bucket but the LLM tends to emit raw character
 * counts. Map: <120 → short, <300 → medium, ≥300 → long.
 */
export const LengthEnum = z.enum(['short', 'medium', 'long']);

export const LengthCoerced = z.preprocess((v) => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v < 120) return 'short';
    if (v < 300) return 'medium';
    return 'long';
  }
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (s === 'short' || s === 'medium' || s === 'long') return s;
    if (s.includes('кратк') || s.includes('коротк') || s.startsWith('s') || s.includes('brief')) return 'short';
    if (s.includes('сред') || s.startsWith('m')) return 'medium';
    if (s.includes('длинн') || s.includes('развёрн') || s.includes('развёрн') || s.startsWith('l') || s.includes('full')) return 'long';
  }
  return v;
}, LengthEnum);

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
 * Urgency enum + tolerant coercer. Same story — models emit synonyms.
 */
export const UrgencyEnum = z.enum(['low', 'normal', 'high']);

export const UrgencyCoerced = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase().trim();
  if (s === 'low' || s === 'normal' || s === 'high') return s;
  if (s.includes('urgent') || s.includes('срочн') || s.includes('критич') || s === 'critical')
    return 'high';
  if (s.includes('низк') || s.includes('небольш') || s.includes('minor')) return 'low';
  if (s.includes('средн') || s.includes('обычн') || s === 'medium' || s === 'med' || s === 'mid')
    return 'normal';
  return v;
}, UrgencyEnum);

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
