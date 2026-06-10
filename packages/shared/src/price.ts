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
/**
 * Parse a price token that may be a RANGE (price-normalization-v2). Returns
 * bounds — `max = null` is an open-ended «от»-range, `min = null` an upper
 * bound «до» — or null when the token is not a price at all:
 *   - "5-7к" / "5—7 тыс"  → { min: 5000, max: 7000 } (multiplier distributes
 *     across BOTH bounds — 5000–7000, not 5–7000)
 *   - "от 118 000"        → { min: 118000, max: null }
 *   - "до 30к"            → { min: null, max: 30000 }
 *   - "47к" / "47 000"    → { min: 47000, max: 47000 }
 */
export function parsePriceRange(raw: string): { min: number | null; max: number | null } | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  // Dash range "A-B[unit]" (hyphen/en/em dash between two numeric tokens).
  const range = /^(?:от\s*)?([\d.,\s]+?)\s*[-–—]\s*([\d.,\s]*[\d][а-яёa-z.\s]*)$/u.exec(s);
  if (range) {
    const right = range[2]!.trim();
    const max = normalizePriceToken(right);
    if (max !== null) {
      const left = range[1]!.trim();
      // Distribute the right side's multiplier unit over a bare left bound.
      const unitMatch = /(к|k|тыс\.?|тысяч[а-яё]*|млн\.?|миллион[а-яё]*|млрд\.?|миллиард[а-яё]*)\s*$/u.exec(
        right,
      );
      const leftToken = unitMatch && /^[\d.,\s]+$/.test(left) ? `${left}${unitMatch[1]}` : left;
      const min = normalizePriceToken(leftToken);
      if (min !== null && min <= max) return { min, max };
    }
  }
  // Upper bound «до X».
  const upTo = /^до\s+(.+)$/u.exec(s);
  if (upTo) {
    const max = normalizePriceToken(upTo[1]!);
    return max === null ? null : { min: null, max };
  }
  // Open-ended «от X» (normalizePriceToken strips the prefix — detect it first).
  const from = /^(?:от)\s+(.+)$/u.exec(s);
  if (from) {
    const min = normalizePriceToken(from[1]!);
    return min === null ? null : { min, max: null };
  }
  const exact = normalizePriceToken(s);
  return exact === null ? null : { min: exact, max: exact };
}

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
