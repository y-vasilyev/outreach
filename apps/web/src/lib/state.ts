/**
 * Tone/label mappings for status-style values shared across screens.
 * Maps every backend enum we render into a `pill` CSS class + visible label.
 */

export type PillClass = 'ok' | 'warn' | 'bad' | 'accent' | 'violet' | 'ghost' | '';

export interface PillSpec {
  cls: PillClass;
  txt: string;
}

const M: Record<string, PillSpec> = {
  // channel statuses
  new: { cls: 'ghost', txt: 'new' },
  scraping: { cls: 'accent', txt: 'скрейп' },
  scraped: { cls: 'accent', txt: 'scraped' },
  extracting: { cls: 'accent', txt: 'extracting' },
  extracted: { cls: 'ok', txt: 'extracted' },
  ready: { cls: 'ok', txt: 'готов' },
  needs_review: { cls: 'warn', txt: 'ревью' },
  failed: { cls: 'bad', txt: 'ошибка' },
  disqualified: { cls: 'bad', txt: 'disqualified' },

  // contact statuses
  queued: { cls: 'ghost', txt: 'в очереди' },
  qualified: { cls: 'ok', txt: 'qualified' },
  contacted: { cls: 'accent', txt: 'contacted' },
  finished: { cls: 'ok', txt: 'finished' },
  invalid: { cls: 'bad', txt: 'invalid' },
  blocked: { cls: 'bad', txt: 'blocked' },
  in_dialog: { cls: 'ok', txt: 'в диалоге' },
  replied: { cls: 'ok', txt: 'ответил' },
  scheduled: { cls: 'violet', txt: 'интервью' },
  manual: { cls: 'warn', txt: 'manual' },
  skipped: { cls: 'ghost', txt: 'пропуск' },
  closed_neg: { cls: 'bad', txt: 'отказ' },
  sent: { cls: 'accent', txt: 'sent' },

  // conversation
  ai_suggesting: { cls: 'accent', txt: 'ИИ готов' },
  needs_op: { cls: 'warn', txt: 'нужен оператор' },

  // campaign
  active: { cls: 'ok', txt: 'active' },
  draft: { cls: 'ghost', txt: 'draft' },
  paused: { cls: 'warn', txt: 'paused' },
  running: { cls: 'ok', txt: 'running' },
  done: { cls: 'ghost', txt: 'done' },

  // tg_account
  idle: { cls: 'ghost', txt: 'idle' },
  warmup: { cls: 'warn', txt: 'warmup' },
  cooldown: { cls: 'bad', txt: 'cooldown' },
  banned: { cls: 'bad', txt: 'banned' },
  need_auth: { cls: 'violet', txt: 'need_auth' },

  // generic
  ok: { cls: 'ok', txt: 'OK' },
  error: { cls: 'bad', txt: 'error' },
  standby: { cls: 'ghost', txt: 'standby' },
  unknown: { cls: 'ghost', txt: 'unknown' },

  // mode
  auto: { cls: 'accent', txt: 'auto' },
  assisted: { cls: 'violet', txt: 'assisted' },

  // role guesses
  owner: { cls: 'ok', txt: 'owner' },
  ad_manager: { cls: 'warn', txt: 'ad_manager' },
  bot: { cls: 'bad', txt: 'bot' },
  generic: { cls: 'ghost', txt: 'generic' },
  parser: { cls: 'violet', txt: 'parser' },
  outreach: { cls: 'accent', txt: 'outreach' },
  both: { cls: 'violet', txt: 'both' },

  // reachability
  reachable_tg: { cls: 'ok', txt: 'reachable_tg' },
  unreachable: { cls: 'bad', txt: 'unreachable' },
};

export function statePill(state: string | null | undefined, fallback: PillSpec = { cls: 'ghost', txt: '—' }): PillSpec {
  if (!state) return fallback;
  return M[state] ?? { cls: 'ghost', txt: state };
}

export const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'tg',
  instagram: 'ig',
  youtube: 'yt',
  tg: 'tg',
  ig: 'ig',
  yt: 'yt',
};

export const PLATFORM_CLASS: Record<string, 'tg' | 'ig' | 'yt'> = {
  telegram: 'tg',
  instagram: 'ig',
  youtube: 'yt',
  tg: 'tg',
  ig: 'ig',
  yt: 'yt',
};

export function avatarColor(seed: string): string {
  // Stable color per id-like seed.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `oklch(0.62 0.10 ${h})`;
}

export function fmtNumShort(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '') + 'K';
  return String(n);
}
