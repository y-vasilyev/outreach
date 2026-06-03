/**
 * Shared constants and lightweight helpers for the agency-sourcing pipeline
 * (harden-agency-sourcing-pipeline change). Pure values/predicates only —
 * everything stateful lives in the worker/api layers.
 */

/**
 * Minimum confidence for an LLM-detected sponsored integration to be
 * eligible as a hook for the agency opener. The
 * `sponsored_integration_detector` already only emits posts it confidently
 * classifies (≥ 0.6 by its prompt contract); this constant is the second
 * gate on the WORKER side so the value lives in ONE place across dispatcher
 * + agent-run.
 */
export const MIN_SPONSORED_CONFIDENCE = 0.6;

/**
 * Pre-gate for the two extractor agents (`rate_card_extractor`,
 * `audience_stats_extractor`). The goal is NOT to detect commerce — it's
 * to avoid spending two LLM calls on obviously empty service-talk turns
 * ("ок", "напишу в 5", "договорились"). Anything that looks like it could
 * carry a real fact MUST pass; the cost of a false negative (silently
 * dropping a price) is much higher than the cost of a false positive (an
 * extractor call that returns empty `data_points`).
 *
 * Pass policy (return `{ pass: true, reason }`):
 *   1. `keyword`         — a commercial / format / audience keyword is present
 *                          (always pass: "прайс отправлю", "медиакит в pdf",
 *                          "стоимость пятнадцать тысяч", "женщины 25-35").
 *   2. `amount_number`   — a number that looks like an amount: 4+ raw digits
 *                          ("15000"), thousand-separated ("15 000"), or a
 *                          к/k suffix ("80к", "5k"). Currency-suffix numbers
 *                          ("5 руб", "100 usd") pass via `keyword` already.
 *   3. `audience_number` — a percent or numeric range typical of audience
 *                          stats ("70%", "18-34", "25–35").
 *   4. `long_text`       — over LONG_TEXT_THRESHOLD characters. A blogger
 *                          writing >60 chars usually has SOMETHING worth
 *                          parsing, even if our patterns missed the marker.
 *
 * Skip policy (return `{ pass: false, reason: 'short_no_signal' }`):
 *   - none of the above. Short, no keyword, no strong numeric pattern.
 *
 * The patterns are intentionally generous on false positives — `\d+%` will
 * fire on "30% скидка" (not an audience stat) too, but the extractor will
 * return empty for it. Better that than dropping "70% женщины".
 *
 * The returned `reason` is consumed by the worker for log counters
 * (`passed_by` / `skipped_by`) so we can tune thresholds with real data.
 */
// Word-boundary on `пост` so "постараюсь" / "постоянно" / "поставка" don't
// trigger a false-positive pass; explicit declensions cover the real cases
// ("пост", "посты", "постов", "посту", "постом", "посте", "постами", "постах").
// Other roots are stable enough as substrings — `интеграц` matches "интеграция",
// `формат` matches "формату", etc., without bleed into common false friends.
//
// IMPORTANT: JS `\b` is defined over ASCII \w only — it doesn't fire on a
// Cyrillic boundary, so "пост от" would treat the "т|space" gap as
// "non-word|non-word" → no boundary, and `\bпост\b` would never match real
// Russian text. We use Unicode lookarounds with the `u` flag instead.
const NOT_LETTER = '(?<![\\p{L}\\p{N}])';
const END_NOT_LETTER = '(?![\\p{L}\\p{N}])';
const COMMERCIAL_KEYWORD_RE = new RegExp(
  '(' +
    // пост / посты / постов / etc. — full-word match only
    `${NOT_LETTER}пост(?:[аеуом]|ы|ов|ами|ах)?${END_NOT_LETTER}` +
    // гео as a standalone token (not the start of "геология")
    `|${NOT_LETTER}гео${END_NOT_LETTER}` +
    // The rest are stable enough as substrings.
    '|сторис|reels|клип|видео|охват|просмотр|подписчик|рекламн|интеграц' +
    '|прайс|цена|стоит|стоимост|руб|₽|тыс|тысяч|млн|миллион|usd|eur|долл|евро' +
    '|медиа\\s*кит|audience|аудитор|формат|размещ|женщин|мужчин|демограф|геогр' +
    ')',
  'iu',
);

// 4+ raw digits ("15000"); 1-3 digits + (space|nbsp|.) + groups of 3 digits
// ("15 000", "15.000"); or 1+ digits then к/k suffix not followed by a letter
// ("80к", "5k" — but NOT "5kg", "5коп"). The Latin k case stays case-insensitive.
const AMOUNT_NUMBER_RE =
  /(?:\d{4,}|\d{1,3}(?:[\s .]\d{3})+|\d+\s*(?:к|k)(?![а-яa-z]))/i;

// Percent ("70%", "70 %") or numeric range with hyphen/en-dash/em-dash
// ("18-34", "25–35"). Typical of audience stats.
const AUDIENCE_NUMBER_RE = /(?:\d+\s*%|\d+\s*[-–—]\s*\d+)/;

/** Above this length we assume there's enough content to warrant extraction. */
const LONG_TEXT_THRESHOLD = 60;

export type PreGateReason =
  | 'keyword'
  | 'amount_number'
  | 'audience_number'
  | 'long_text'
  | 'short_no_signal';

export interface PreGateResult {
  pass: boolean;
  reason: PreGateReason;
}

/**
 * Classify an inbound for the profile-extract pre-gate. See file header.
 */
export function preGateExtraction(text: string): PreGateResult {
  if (!text || typeof text !== 'string') {
    return { pass: false, reason: 'short_no_signal' };
  }
  if (COMMERCIAL_KEYWORD_RE.test(text)) return { pass: true, reason: 'keyword' };
  if (AMOUNT_NUMBER_RE.test(text)) return { pass: true, reason: 'amount_number' };
  if (AUDIENCE_NUMBER_RE.test(text)) return { pass: true, reason: 'audience_number' };
  if (text.length > LONG_TEXT_THRESHOLD) return { pass: true, reason: 'long_text' };
  return { pass: false, reason: 'short_no_signal' };
}

/**
 * Boolean form — back-compat for the prior `hasCommercialSignal` API.
 * Prefer `preGateExtraction` when you also want to log the reason.
 */
export function hasCommercialSignal(text: string): boolean {
  return preGateExtraction(text).pass;
}
