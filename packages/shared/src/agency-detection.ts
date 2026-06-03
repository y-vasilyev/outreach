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
 * Cheap deterministic detector — does the inbound carry any commercial
 * signal at all? Used as a pre-gate before the two extractor agents so we
 * don't burn LLM calls on turns like "ок, давай в пятницу". NOT a content
 * classifier — only a filter. False positives are fine (extractors
 * gracefully return empty data_points); false negatives are what we
 * actively avoid here, so the regex is generous on currency/format/
 * audience keywords.
 *
 * Returns true iff the text contains AT LEAST ONE digit AND AT LEAST ONE
 * commercial keyword.
 */
const COMMERCIAL_KEYWORD_RE = /(пост|сторис|reels|клип|видео|охват|просмотр|подписчик|рекламн|интеграц|прайс|цена|стоит|стоимост|руб|₽|тыс|млн|\bk\b|usd|eur|долл|евро|медиа\s*кит|audience|аудитор)/i;
const DIGIT_RE = /\d/;

export function hasCommercialSignal(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return DIGIT_RE.test(text) && COMMERCIAL_KEYWORD_RE.test(text);
}
