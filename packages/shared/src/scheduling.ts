/**
 * Campaign schedule (mirrors the JSON shape stored in `campaign.schedule`).
 * All fields are optional — the absence of a constraint means "always on".
 */
export interface CampaignSchedule {
  /** IANA timezone, e.g. "Europe/Moscow". Defaults to UTC. */
  tz?: string;
  /** Days of week the campaign is allowed to run. 0 = Sun … 6 = Sat. */
  days?: number[];
  workHours?: { start?: string; end?: string };
  /** Stricter-of cap: per-account daily limit AND this. */
  maxPerDayPerAccount?: number;
}

/**
 * Returns true when the current wall-clock time falls inside `schedule.days`
 * AND `schedule.workHours`, both interpreted in `schedule.tz`.
 *
 * Missing fields = "no constraint": an empty schedule means "always on".
 * Time strings must be `HH:MM` 24-hour format.
 *
 * Time-zone resolution uses `Intl.DateTimeFormat` with a numeric hour/minute
 * formatter — no third-party tz library needed.
 */
export function isWithinSchedule(s: CampaignSchedule, at: Date = new Date()): boolean {
  const tz = s.tz || 'UTC';

  if (Array.isArray(s.days) && s.days.length > 0) {
    const dayName = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: tz,
    }).format(at);
    const map: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const wd = map[dayName] ?? -1;
    if (!s.days.includes(wd)) return false;
  }

  if (s.workHours?.start && s.workHours.end) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    });
    const parts = fmt.formatToParts(at);
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const cur = `${h}:${m}`;
    if (cur < s.workHours.start || cur >= s.workHours.end) return false;
  }
  return true;
}
