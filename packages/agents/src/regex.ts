/**
 * Regex detectors + context analysis used by ContactExtractor.
 *
 * Two passes:
 *  1. `runRegexCandidates(text)` finds shapes (`@handle`, `t.me/x`, emails,
 *     phones, URLs) and emits a deduped candidate list with a ±60-char
 *     context window per match.
 *  2. Each candidate is annotated with two derived fields:
 *       - `role_hint`  — deterministic guess from the surrounding text
 *                        (ad_manager / owner / bot / generic / unknown).
 *                        Cheap prior the LLM can override.
 *       - `deny_reason` — non-empty string when the candidate is almost
 *                        certainly NOT an outreach contact (regulator URL,
 *                        self-reference, payment processor, …). Worker
 *                        drops these before the LLM call.
 *
 * Why two layers: pure regex can't reason about meaning, but it CAN reject
 * obvious non-contacts cheaply, and feeding the LLM a hand-curated role
 * prior lifts role accuracy a lot for Yandex-tier models. Anything genuinely
 * ambiguous still flows to the LLM.
 *
 * Conventions:
 *  - All exported regexes are FRESH instances, not shared. They use the `g`
 *    flag (and sometimes `i`), so callers must not call `.exec()` in a loop
 *    on the same instance — use the helpers below or call `.matchAll()`.
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

export type RoleHint = 'owner' | 'ad_manager' | 'bot' | 'generic' | 'unknown';

export interface RegexCandidate {
  type: RegexCandidateType;
  raw_value: string;
  context_snippet: string;
  /** Deterministic role guess from the surrounding text. LLM may override. */
  role_hint: RoleHint;
  /**
   * Non-empty when the candidate is almost certainly NOT an outreach
   * contact (regulator URL, self-reference, payment processor, cross-promo
   * mention, course/product CTA). The contact-extract worker drops these
   * before the LLM call AND re-applies the same filter post-LLM.
   */
  deny_reason?: string;
}

export interface RegexOptions {
  /**
   * Channel's own handle (without `@`, lowercased). Used to mark
   * self-references as deny_reason='self_handle'. Optional — when absent
   * we still emit candidates, just don't apply the self-handle filter.
   */
  channelHandle?: string;
}

/**
 * Scan `text` for known contact-shaped tokens and return de-duplicated
 * candidates with a 60-char window of surrounding context, a deterministic
 * role hint, and an optional deny reason.
 *
 * Order is preserved (first occurrence wins). Dedup key is `${type}::${raw}`
 * (case-insensitive on the value).
 */
export function runRegexCandidates(
  text: string,
  opts: RegexOptions = {},
): RegexCandidate[] {
  if (!text) return [];

  const out: RegexCandidate[] = [];
  const seen = new Set<string>();
  const channelHandle = opts.channelHandle?.replace(/^@/, '').toLowerCase();

  const push = (
    type: RegexCandidateType,
    raw: string,
    matchStart: number,
    matchEnd: number,
  ) => {
    const key = `${type}::${raw.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const snippet = makeSnippet(text, matchStart, matchEnd);
    const role_hint = inferRoleFromContext(snippet, type, raw);
    const deny_reason = inferDenyReason(type, raw, snippet, channelHandle);
    out.push({
      type,
      raw_value: raw,
      context_snippet: snippet,
      role_hint,
      ...(deny_reason ? { deny_reason } : {}),
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

/* -------------------------------------------------------------------------- */
/* Context analysis                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Keyword groups. We use plain substring matches for Russian stems because
 * JS `\b` is ASCII-only — Cyrillic characters are NOT word-characters in
 * the regex engine, so `\bреклам` never fires on "По рекламе" (the
 * boundary between space and `р` is non-boundary in JS).
 *
 * Substring is fine here: each stem is distinctive enough that incidental
 * matches inside other words are rare AND the candidate has already been
 * isolated by handle/URL detection — we're only classifying ±60 chars
 * around a known contact-shape.
 *
 * English words still use `\b` regex because there `boundary` works
 * correctly and we need it (e.g. "ad" must not match inside "address").
 *
 * Order of checks in `inferRoleFromContext`: AD_MANAGER ≻ BOT ≻ OWNER ≻
 * SUPPORT ≻ unknown.
 */
const AD_MANAGER_RU = [
  'реклам', 'коллаб', 'сотруднич', 'интеграц', 'партнёрств', 'партнерств',
  'размещен', 'маркетинг', 'медиабай', 'менеджер', 'продаж',
  'для бизнес',
];
const AD_MANAGER_EN =
  /\b(?:business|advertis(?:e|ing)|promo|collab|sponsor|partnership|sales|ads)\b/i;

const OWNER_RU = [
  'автор', 'основат', 'создат', 'редакт',
  'пишу я', 'веду канал', 'связаться со мной', 'мой канал', 'это мой',
];
const OWNER_EN = /\b(?:founder|owner|editor)\b/i;

const BOT_HANDLE_RE = /(?:^|@)[a-z0-9_]+_?bot$/i;
const BOT_CONTEXT_RU = ['бот', 'для заявок', 'форма'];
const BOT_CONTEXT_EN = /\bbot\b/i;

const SUPPORT_RU = ['поддержк', 'помощ', 'вопрос', 'связ', 'обратной связ'];
const SUPPORT_EN = /\b(?:support|customer)\b/i;

const CROSS_PROMO_RU = [
  'наш второ', 'наш друго', 'наш ещё', 'наш еще',
  'подпис', 'перейд', 'читайте', 'смотрите',
];
const CROSS_PROMO_EN =
  /\b(?:second\s+channel|other\s+channel|subscribe|follow\s+us)\b/i;

const NO_ADS_RU = [
  'не размещ', 'не приним', 'не публику', 'без реклам', 'не рекламирую',
];
const NO_ADS_EN = /\b(?:no\s+ads?|no\s+advertis)\b/i;

const COURSE_RU = [
  'курс', 'обучен', 'тренинг', 'вебинар', 'интенсив',
  'записаться', 'записаться на', 'приглашаю на', 'оплат', 'регистрац',
];
const COURSE_EN = /\b(?:course|register|enroll|sign\s+up)\b/i;

function hasAny(s: string, ruStems: readonly string[], enRe: RegExp): boolean {
  for (const w of ruStems) {
    if (s.includes(w)) return true;
  }
  return enRe.test(s);
}

/**
 * Infer the most likely role for a candidate based on its surrounding text.
 * Conservative: 'unknown' is the default; we only commit when we see a
 * clear keyword cluster.
 */
export function inferRoleFromContext(
  snippet: string,
  type: RegexCandidateType,
  rawValue: string,
): RoleHint {
  const s = snippet.toLowerCase();
  const isAds = hasAny(s, AD_MANAGER_RU, AD_MANAGER_EN);

  // Telegram-bot suffix is a deterministic signal regardless of context.
  if (type === 'tg_username' || type === 'tg_link') {
    if (BOT_HANDLE_RE.test(rawValue)) {
      return isAds ? 'ad_manager' : 'bot';
    }
  }

  if (isAds) return 'ad_manager';
  if (hasAny(s, BOT_CONTEXT_RU, BOT_CONTEXT_EN)) return 'bot';
  if (hasAny(s, OWNER_RU, OWNER_EN)) return 'owner';
  if (hasAny(s, SUPPORT_RU, SUPPORT_EN)) return 'generic';
  return 'unknown';
}

/**
 * Domains that are unambiguously not outreach contacts.
 * Sourced from observed false positives in real channel descriptions.
 */
const REGULATOR_DOMAINS = [
  'rkn.gov.ru',
  'gosuslugi.ru',
  'nalog.ru',
  'kremlin.ru',
  'mid.ru',
  'duma.gov.ru',
  'roskomnadzor.ru',
  'digital.gov.ru',
  '212-fz',
  'fz-422',
  // RKN registration redirector pattern
  'knd.gov.ru',
];

/** Payment / donation / referral processors — never an outreach contact. */
const PAYMENT_DOMAINS = [
  'qiwi.com',
  'qiwi.me',
  'yoomoney.ru',
  'donationalerts.com',
  'donationalerts.ru',
  'cloudpayments.ru',
  'pay.ozon.ru',
  'boosty.to',
  'patreon.com',
  'paypal.me',
  'paypal.com',
  'wmtransfer.com',
];

/** TLDs of obvious government / public services. */
const GOV_TLD_RE = /\.(?:gov(?:\.\w+)?|government|gob)\b/i;

/**
 * Decide whether a candidate is junk. Returns a short reason string when
 * yes, otherwise `undefined`. The worker pre-filters denied candidates and
 * also re-applies the same checks after the LLM in case it added them
 * back (LLMs love to "rescue" noisy URLs).
 */
export function inferDenyReason(
  type: RegexCandidateType,
  rawValue: string,
  snippet: string,
  channelHandle: string | undefined,
): string | undefined {
  const value = rawValue.toLowerCase();
  const s = snippet.toLowerCase();

  // 1. Self-reference: candidate is the channel itself.
  if (channelHandle && (type === 'tg_username' || type === 'tg_link')) {
    const handle = value.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').replace(/^t\.me\//, '');
    if (handle === channelHandle) return 'self_handle';
  }

  // 2. Government / regulator domains.
  if (type === 'website') {
    if (GOV_TLD_RE.test(value)) return 'regulator_domain';
    for (const d of REGULATOR_DOMAINS) {
      if (value.includes(d)) return 'regulator_domain';
    }
    for (const d of PAYMENT_DOMAINS) {
      if (value.includes(d)) return 'payment_processor';
    }
  }

  // 3. "We don't accept ads" disclaimers near a contact.
  if (hasAny(s, NO_ADS_RU, NO_ADS_EN)) return 'declines_ads';

  // 4. Cross-promo mention (subscribe to our other channel) — these are
  //    usually `t.me/<channel>` link/handles next to "наш второй канал".
  if (
    (type === 'tg_link' || type === 'tg_username') &&
    hasAny(s, CROSS_PROMO_RU, CROSS_PROMO_EN)
  ) {
    return 'cross_promo';
  }

  // 5. Course / product CTAs — links inside "запишитесь на курс".
  if (type === 'website' && hasAny(s, COURSE_RU, COURSE_EN)) {
    return 'course_or_product';
  }

  return undefined;
}
