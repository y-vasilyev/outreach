import type { HistoryMessage } from '../types.js';

/**
 * Pure helper that wraps GramJS `client.getMessages` (which itself wraps
 * `messages.getHistory`) into our typed `HistoryMessage` shape. Lives in a
 * separate file so the call site in `SessionManager` stays compact and so
 * we have a single place to evolve the mapping when GramJS shape changes.
 *
 * - `limit` is hard-clamped to ≤ 50 messages (chat-autonomous-modes
 *   design.md Decision 4: bounded fetch keeps the call cheap and
 *   FloodWait-friendly).
 * - When `sinceTgMsgId` is provided, GramJS's `minId` filter returns
 *   only messages with id > sinceTgMsgId. Otherwise we return the most
 *   recent slice.
 * - Mapping never throws — malformed entries become best-effort
 *   strings; the caller dedupes downstream against persisted
 *   `Message.tgMsgId`.
 */

const MAX_LIMIT = 50;

interface GramJSGetMessagesClient {
  getMessages: (
    target: unknown,
    opts: { limit: number; minId?: number },
  ) => Promise<unknown>;
}

interface GramJSHistoryRow {
  id?: number | { toString(): string };
  message?: string;
  text?: string;
  out?: boolean;
  date?: number;
  peerId?: { className?: string; userId?: { toString?(): string } };
  senderId?: { toString?(): string };
  fromId?: { className?: string; userId?: { toString?(): string } };
  sender?: { username?: string; firstName?: string; lastName?: string } | null;
  _sender?: { username?: string; firstName?: string; lastName?: string } | null;
}

export async function fetchHistorySinceImpl(
  client: GramJSGetMessagesClient,
  opts: {
    tgAccountId: string;
    peerKey: string;
    sinceTgMsgId?: string;
    limit?: number;
  },
): Promise<HistoryMessage[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_LIMIT, MAX_LIMIT));
  const minId = opts.sinceTgMsgId ? Number(opts.sinceTgMsgId) : undefined;
  const rows = (await client.getMessages(opts.peerKey, {
    limit,
    ...(minId && Number.isFinite(minId) ? { minId } : {}),
  })) as GramJSHistoryRow[];

  return (Array.isArray(rows) ? rows : [])
    .map((m) => mapHistoryRow(m, opts.tgAccountId))
    .filter((m): m is HistoryMessage => m !== null);
}

function mapHistoryRow(m: GramJSHistoryRow, tgAccountId: string): HistoryMessage | null {
  const tgMsgId =
    typeof m.id === 'number'
      ? String(m.id)
      : typeof m.id === 'object' && m.id
        ? m.id.toString()
        : '';
  if (!tgMsgId) return null;

  const text = typeof m.message === 'string' ? m.message : typeof m.text === 'string' ? m.text : '';
  if (!text) return null;

  // peerId.userId is the OTHER party in a 1-1 chat regardless of direction.
  const peerTgUserId = m.peerId?.userId?.toString?.() ?? '';
  if (!peerTgUserId) return null;

  const out = m.out === true;
  // For inbound, sender == peer. For outbound, sender == us; we don't have
  // our own id wired up here, so we leave fromTgUserId empty for outbound
  // (consumer doesn't use fromTgUserId for outbound persistence).
  const fromTgUserId = out
    ? (m.senderId?.toString?.() ?? m.fromId?.userId?.toString?.() ?? '')
    : peerTgUserId;

  const dateNum = typeof m.date === 'number' ? m.date : 0;
  const sentAt = dateNum
    ? new Date(dateNum * 1000).toISOString()
    : new Date().toISOString();

  const sender = m.sender ?? m._sender;
  const fromUsername =
    typeof sender?.username === 'string' && sender.username ? sender.username : undefined;
  const fromFirstName =
    typeof sender?.firstName === 'string' && sender.firstName ? sender.firstName : undefined;
  const fromLastName =
    typeof sender?.lastName === 'string' && sender.lastName ? sender.lastName : undefined;

  return {
    tgAccountId,
    peerTgUserId,
    fromTgUserId,
    text,
    tgMsgId,
    sentAt,
    out,
    ...(fromUsername !== undefined && { fromUsername }),
    ...(fromFirstName !== undefined && { fromFirstName }),
    ...(fromLastName !== undefined && { fromLastName }),
  };
}
