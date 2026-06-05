import { scoreContactPriority } from '@nosquare/shared';

export interface DedupeCandidate {
  id: string;
  channelId: string | null;
  /** True when the conversation has ≥1 message (inbound OR outbound). */
  hasMessages: boolean;
  roleGuess: string;
  type: string;
  confidence: unknown;
  createdAtMs: number;
}

export interface DedupeResult {
  scannedChannels: number;
  duplicateChannels: number;
  removed: number;
}

/**
 * Decide which duplicate conversations to remove so each channel keeps a
 * single outreach thread. Pure (no DB) for unit-testability.
 *
 * Rules per channel (conversations whose contacts share a `channelId`):
 *   - A conversation we already engaged (any message, inbound OR outbound) is
 *     ALWAYS kept — «если я уже кому-то написал, оставляем этот чат». A sent
 *     message is a real relationship we must never drop.
 *   - If at least one engaged conversation exists on the channel, every *empty*
 *     (zero-message) duplicate there is removed.
 *   - If none are engaged, keep the single best contact (ad_manager > owner >
 *     generic > …, then type, then confidence; oldest wins ties) and remove the
 *     rest.
 * Cold-lead conversations (contact has no channel) are never touched.
 */
export function planConversationDedupe(rows: DedupeCandidate[]): string[] {
  const byChannel = new Map<string, DedupeCandidate[]>();
  for (const r of rows) {
    if (r.channelId == null) continue;
    const group = byChannel.get(r.channelId);
    if (group) group.push(r);
    else byChannel.set(r.channelId, [r]);
  }

  const remove: string[] = [];
  for (const group of byChannel.values()) {
    if (group.length < 2) continue;
    const empty = group.filter((c) => !c.hasMessages);
    const engagedCount = group.length - empty.length;
    if (engagedCount > 0) {
      // Keep every engaged thread; drop only the empty shells.
      remove.push(...empty.map((c) => c.id));
      continue;
    }
    // Nobody reached out yet — keep the single best contact, remove the rest.
    const ranked = [...empty].sort(
      (a, b) =>
        scoreContactPriority(b) - scoreContactPriority(a) || a.createdAtMs - b.createdAtMs,
    );
    remove.push(...ranked.slice(1).map((c) => c.id));
  }
  return remove;
}
