/**
 * Shared "which contact of a channel do we engage?" priority. An explicitly
 * published advertising/manager contact ("Сотрудничество: менеджер @…",
 * `role_guess=ad_manager`) must win over a channel owner or a general
 * "По вопросам" contact on the same channel.
 *
 * Used by:
 *   - the campaign dispatcher — who to message first / dedup per channel, and
 *   - the inbox conversation-dedup — which empty duplicate conversation to keep.
 *
 * Mirrors `ContactPrioritizer`'s deterministic ROLE_BASE / TYPE_BONUS so all
 * three sites rank contacts identically.
 */
export const CONTACT_ROLE_PRIORITY: Record<string, number> = {
  ad_manager: 100,
  owner: 80,
  generic: 50,
  bot: 25,
  unknown: 10,
};

export const CONTACT_TYPE_BONUS: Record<string, number> = {
  tg_username: 15,
  tg_link: 12,
  email: 6,
  phone: 4,
  web_form: 2,
  website: 1,
  other: 0,
};

export interface ContactPriorityInput {
  roleGuess: string;
  type: string;
  /** Prisma `Decimal`, number, or string — coerced via `Number`. */
  confidence: unknown;
}

/**
 * Base priority of a contact: role dominates, then contact type, then
 * confidence as a tiebreak. Higher = better. An `ad_manager` always outranks
 * an `owner` regardless of confidence (100 vs 80 base, confidence adds ≤10).
 * Callers may add their own context-specific bonus (e.g. an operator's
 * explicit campaign tag) on top of this base.
 */
export function scoreContactPriority(c: ContactPriorityInput): number {
  const role = CONTACT_ROLE_PRIORITY[c.roleGuess] ?? 0;
  const typeBonus = CONTACT_TYPE_BONUS[c.type] ?? 0;
  const conf = Math.round(Number(c.confidence ?? 0) * 10);
  return role + typeBonus + conf;
}
