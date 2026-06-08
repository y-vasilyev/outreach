/**
 * Shared price normalization (harden-reply-extraction).
 *
 * Single source of truth for turning the free-form price tokens bloggers write
 * into a finite number. Used by both the deterministic text parser
 * (`blogger-profile-enrichment.ts`) and the placement-offer zod schema
 * (`schemas/placement-offer.ts` price coercion), so coercion is identical
 * wherever a price enters the system.
 *
 * Kept dependency-free (no imports) to avoid an import cycle between the schema
 * and the enrichment parser.
 *
 * Grammar handled (Russian commercial replies):
 *   - thin / regular / non-breaking spaces as thousands separators (JS `\s`
 *     matches NBSP and thin space): "118 000" -> 118000
 *   - "от"/"~"/"≈"/"около"/"примерно" approximation prefixes: "от 118000" -> 118000
 *   - multipliers: к / k / тыс[.] / тысяч* -> ×1000; млн / млн. / миллион* ->
 *     ×1_000_000; млрд / миллиард* -> ×1_000_000_000
 *   - comma OR dot decimal: "1,2 млн" / "1.2млн" -> 1200000
 *   - trailing currency markers are NOT consumed here (the parser handles
 *     currency separately); a bare number with a unit is accepted.
 *
 * Returns `null` (NOT 0) when the token is not a recognizable price, so callers
 * can keep a term-only offer (`price = null`) rather than fabricate a number.
 */

const MULTIPLIER_RE = /^(к|k|тыс|тысяч[а-яё]*|млн|миллион[а-яё]*|млрд|миллиард[а-яё]*)$/;

function multiplierFor(unit: string | undefined): number {
  if (!unit) return 1;
  const u = unit.replace(/\.$/, '');
  if (/^(к|k|тыс|тысяч)/.test(u)) return 1_000;
  if (/^(млн|миллион)/.test(u)) return 1_000_000;
  if (/^(млрд|миллиард)/.test(u)) return 1_000_000_000;
  return 1;
}

/**
 * Normalize a raw price token to a finite non-negative number, or `null` when
 * it is not a price. Strips approximation prefixes, spaces, and currency-free
 * unit multipliers.
 */
export function normalizePriceToken(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:от|примерно|около|~|≈)\s*/u, '')
    // collapse all whitespace (incl. NBSP / thin space, both matched by \s)
    .replace(/\s+/g, '');
  // Split the numeric core from an optional trailing multiplier unit.
  const m =
    /^([\d.,]+)(к|k|тыс\.?|тысяч[а-яё]*|млн\.?|миллион[а-яё]*|млрд\.?|миллиард[а-яё]*)?$/.exec(s);
  if (!m) return null;
  let num = m[1]!;
  // Disambiguate the dot/comma: groups of EXACTLY three digits are a thousands
  // separator ("12.000" / "267.000" / "1.200.000" -> 12000 / 267000 / 1200000),
  // otherwise the separator is a decimal point ("1.2млн" -> 1.2, "1.5к" -> 1.5).
  if (/^\d{1,3}(\.\d{3})+$/.test(num)) num = num.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(num)) num = num.replace(/,/g, '');
  else num = num.replace(',', '.');
  const n = Number(num);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2]?.replace(/\.$/, '');
  return Math.round(n * (unit && MULTIPLIER_RE.test(unit) ? multiplierFor(unit) : 1));
}
