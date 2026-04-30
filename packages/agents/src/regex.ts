/**
 * Regex detectors used by ContactExtractor (and reusable by workers / tests).
 *
 * Conventions:
 *  - All exported regexes are FRESH instances, not shared. They use the `g` flag
 *    (and sometimes `i`), so callers must not call `.exec()` in a loop on the
 *    same instance — use the helpers below or call `.matchAll()`.
 *  - `runRegexCandidates` produces a single de-duplicated list of candidates
 *    suitable for feeding to ContactExtractor.
 */

export const tgUsernameRegex = /(?:^|[\s>(])@([a-zA-Z][\w]{4,31})\b/g;
export const tgLinkRegex = /(?:https?:\/\/)?t\.me\/([a-zA-Z][\w]{4,31})/gi;

// RFC 5322 simplified. Good enough for description scraping; real validation
// happens at send-time.
export const emailRegex =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// International phone format: optional +, 7..15 digits, spaces / dashes / dots
// allowed inside. Requires at least 7 digit characters total.
export const phoneRegex =
  /(?:(?<![\w@])\+?\d[\d\s().-]{6,20}\d)(?!\w)/g;

// http(s) URLs — including bare domains? No, only explicit scheme to keep it
// targeted. ContactExtractor's LLM step covers oddly-formatted links.
export const urlRegex =
  /https?:\/\/[^\s<>"')]+/gi;

export type RegexCandidateType =
  | 'tg_username'
  | 'tg_link'
  | 'email'
  | 'phone'
  | 'website'
  | 'other';

export interface RegexCandidate {
  type: RegexCandidateType;
  raw_value: string;
  context_snippet: string;
}

/**
 * Scan `text` for known contact-shaped tokens and return de-duplicated
 * candidates with a 60-char window of surrounding context.
 *
 * Order is preserved (first occurrence wins). Dedup key is `${type}::${raw}`
 * (case-insensitive on the value).
 */
export function runRegexCandidates(text: string): RegexCandidate[] {
  if (!text) return [];

  const out: RegexCandidate[] = [];
  const seen = new Set<string>();

  const push = (
    type: RegexCandidateType,
    raw: string,
    matchStart: number,
    matchEnd: number,
  ) => {
    const key = `${type}::${raw.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      type,
      raw_value: raw,
      context_snippet: makeSnippet(text, matchStart, matchEnd),
    });
  };

  // Telegram usernames. Capture group 1 is the bare handle (no @).
  // We rebuild the raw value as `@handle` for downstream LLM clarity.
  for (const m of text.matchAll(new RegExp(tgUsernameRegex.source, 'g'))) {
    const handle = m[1];
    if (!handle) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    push('tg_username', `@${handle}`, start, end);
  }

  // t.me/<handle> links.
  for (const m of text.matchAll(new RegExp(tgLinkRegex.source, 'gi'))) {
    const handle = m[1];
    if (!handle) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    push('tg_link', m[0], start, end);
  }

  // Emails.
  for (const m of text.matchAll(new RegExp(emailRegex.source, 'g'))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    push('email', m[0], start, end);
  }

  // Phones — guard: at least 7 digit characters in the captured slice.
  for (const m of text.matchAll(new RegExp(phoneRegex.source, 'g'))) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7) continue;
    const start = m.index ?? 0;
    const end = start + raw.length;
    push('phone', raw.trim(), start, end);
  }

  // Websites — exclude t.me links (already captured as tg_link).
  for (const m of text.matchAll(new RegExp(urlRegex.source, 'gi'))) {
    const url = m[0];
    if (/(^|\/\/)(www\.)?t\.me\//i.test(url)) continue;
    const start = m.index ?? 0;
    const end = start + url.length;
    push('website', url, start, end);
  }

  return out;
}

/** Build a ±60 char snippet around `[start, end)` in `text`. */
function makeSnippet(text: string, start: number, end: number): string {
  const radius = 60;
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  let snippet = text.slice(from, to);
  // Collapse whitespace for log readability.
  snippet = snippet.replace(/\s+/g, ' ').trim();
  if (from > 0) snippet = `…${snippet}`;
  if (to < text.length) snippet = `${snippet}…`;
  return snippet;
}
