const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return dateFmt.format(d);
}

export function formatDateTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return dateTimeFmt.format(d);
}

export function formatTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return timeFmt.format(d);
}

export function formatRelative(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 30) return 'только что';
  if (sec < 60) return `${sec} с`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ч назад`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} д назад`;
  return formatDate(d);
}

/**
 * Coerce wire-format numbers to a JS number.
 *
 * Prisma's `Decimal` columns serialise to JSON as **strings** by default
 * (e.g. `"0.42"`, not `0.42`). The wire schema declares them as numbers but
 * older API responses or ones we haven't fixed yet may still leak strings —
 * formatters need to be tolerant so they don't crash with
 * `n.toFixed is not a function`.
 */
function toNum(n: number | string | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : null;
}

export function formatNumber(n: number | string | null | undefined): string {
  const v = toNum(n);
  if (v === null) return '—';
  return new Intl.NumberFormat('ru-RU').format(v);
}

export function formatCompact(n: number | string | null | undefined): string {
  const v = toNum(n);
  if (v === null) return '—';
  return new Intl.NumberFormat('ru-RU', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(v);
}

export function formatMoney(n: number | string | null | undefined): string {
  const v = toNum(n);
  if (v === null) return '$0.00';
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

export function formatPct(n: number | string | null | undefined, digits = 1): string {
  const v = toNum(n);
  if (v === null) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function truncate(s: string | null | undefined, max = 80): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function initials(s: string | null | undefined, fallback = '??'): string {
  if (!s) return fallback;
  return s.slice(0, 2).toUpperCase();
}
