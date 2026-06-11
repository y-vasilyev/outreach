import type { PillClass } from '../../lib/state';
import type { ProfileFreshnessSection } from './types';

// Shared freshness presentation (decision-ux): the full panel in the audit
// section and the inline per-metric badges must speak the same language.
// Tone reflects the operator-workflow question "do we have a recent enough
// source for this section?":
//   - no contributing points → ghost (нет данных)
//   - within TTL              → ok (свежо)
//   - past TTL                → warn (устарело)
export function freshnessTone(s: ProfileFreshnessSection): PillClass {
  if (s.ageDays == null) return 'ghost';
  return s.stale ? 'warn' : 'ok';
}

export function freshnessAgeText(s: ProfileFreshnessSection): string {
  if (s.ageDays == null) return 'нет данных';
  if (s.ageDays === 0) return 'сегодня';
  return `${s.ageDays} д`;
}

export function freshnessStatusWord(s: ProfileFreshnessSection): string {
  if (s.ageDays == null) return 'нет данных';
  return s.stale ? 'устарело' : 'свежо';
}

/**
 * Same signal a sighted user gets from the pill colour, reachable for
 * keyboard / screen-reader users (codex M1 R1).
 */
export function freshnessTooltip(label: string, s: ProfileFreshnessSection): string {
  return `${label}: ${freshnessStatusWord(s)}${s.ageDays != null ? `, ${freshnessAgeText(s)}` : ''}`;
}
