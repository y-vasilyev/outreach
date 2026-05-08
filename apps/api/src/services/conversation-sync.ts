import { getPrisma } from '@nosquare/db';
import { isAppError } from '@nosquare/shared/errors';

import { logger } from '../logger.js';
import { getQueues } from '../queues.js';
import { emitToRoom } from '../realtime/io.js';
import { getTgClient } from './tg-accounts.js';

/**
 * Conversation-sync service.
 *
 * Triggered when the operator opens a conversation (`GET
 * /conversations/:id`). The push path (`tg-listen`) is the primary way
 * inbound messages reach the DB, but it can miss messages while
 * workers are restarting or while the GramJS client is reconnecting
 * (especially over MTProxy). On open, we explicitly fetch the most
 * recent slice of the chat, dedupe it against `Message.tgMsgId`, and
 * persist anything new — same code path the push listener would have
 * used. The most recent newly-persisted inbound triggers a fresh
 * `agent-run on_inbound` so the suggestion pipeline reflects the
 * latest state.
 *
 * Bound to a hard time budget by the route handler — see `syncOne()`.
 */

const HISTORY_LIMIT = 50;
const CACHE_TTL_MS = 30_000;

interface SyncResult {
  /** Number of brand-new messages persisted by this call. */
  persisted: number;
  /** True when at least one inbound was new and an agent-run was enqueued. */
  triggeredOnInbound: boolean;
  /** True when sync was served from the in-memory TTL cache (no TG call). */
  cached: boolean;
  /** Reason the call was a no-op when relevant. */
  skipped?: string;
}

interface CacheEntry {
  result: SyncResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Test-only: drop the in-memory sync cache so tests can run consecutive
 * calls against the same conversation id without one bleeding into the
 * next. Production callers should never need this.
 */
export function _resetSyncCacheForTests(): void {
  cache.clear();
}

/**
 * Backfill missed messages for a single conversation against Telegram and
 * trigger fresh suggestion generation on the most recent new inbound.
 *
 * Idempotent: dedupes against the unique `(conversationId, tgMsgId)`
 * index, so re-runs and overlap with the push path are safe.
 *
 * Failure modes are graceful — FloodWait and transport errors are
 * logged and swallowed; the operator's GET still succeeds with the
 * current DB state.
 */
export async function syncOne(conversationId: string): Promise<SyncResult> {
  // Coalesce rapid repeat opens. The TTL avoids burning quota on the
  // common UX of a user clicking, scrolling, and re-clicking the same
  // chat in <30s.
  const now = Date.now();
  const cached = cache.get(conversationId);
  if (cached && cached.expiresAt > now) {
    return { ...cached.result, cached: true };
  }

  const prisma = getPrisma();
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      tgAccountId: true,
      contactId: true,
      contact: {
        select: { id: true, tgUserId: true, tgUsername: true, value: true, type: true },
      },
    },
  });
  if (!conv) {
    return { persisted: 0, triggeredOnInbound: false, cached: false, skipped: 'no_conversation' };
  }

  // Resolve the peer key. tgUserId is most reliable; fall back to
  // tgUsername (which the listener back-fills); finally to `value` for
  // legacy `tg_username` rows. Without ANY of these we can't address
  // the peer — log and bail.
  const peerKey =
    conv.contact.tgUserId ||
    (conv.contact.tgUsername ? `@${conv.contact.tgUsername}` : '') ||
    (conv.contact.type === 'tg_username' && conv.contact.value
      ? `@${conv.contact.value.replace(/^@/, '')}`
      : '');
  if (!peerKey) {
    return { persisted: 0, triggeredOnInbound: false, cached: false, skipped: 'no_peer_key' };
  }

  // Highest known tgMsgId for this conversation. We fetch from there.
  // Stored as a string, but tg ids are int64 — Number() is fine for the
  // range Telegram actually uses (tg uses 32-bit message ids per peer).
  const lastMsg = await prisma.message.findFirst({
    where: { conversationId: conv.id, tgMsgId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { tgMsgId: true },
  });

  let history;
  try {
    const handle = await getTgClient().for(conv.tgAccountId);
    if (!handle.isAuthorized) {
      return {
        persisted: 0,
        triggeredOnInbound: false,
        cached: false,
        skipped: 'tg_account_not_authorized',
      };
    }
    history = await handle.fetchHistorySince({
      peerKey,
      ...(lastMsg?.tgMsgId ? { sinceTgMsgId: lastMsg.tgMsgId } : {}),
      limit: HISTORY_LIMIT,
    });
  } catch (err) {
    // FloodWait is RATE_LIMITED in our taxonomy. We do NOT retry inline
    // — the operator's GET should still respond fast. Log + count, the
    // next sync window will retry.
    const code = isAppError(err) ? err.code : 'TRANSIENT';
    if (code === 'RATE_LIMITED') {
      logger.warn(
        {
          event: 'tg.flood_wait',
          conversationId,
          tgAccountId: conv.tgAccountId,
          err: (err as Error).message,
        },
        'conversation-sync hit FloodWait',
      );
    } else {
      logger.warn(
        {
          event: 'conversation_sync.tg_error',
          conversationId,
          tgAccountId: conv.tgAccountId,
          code,
          err: (err as Error).message,
        },
        'conversation-sync TG transport error',
      );
    }
    const result: SyncResult = {
      persisted: 0,
      triggeredOnInbound: false,
      cached: false,
      skipped: 'tg_error',
    };
    // Don't cache failures — let the next open retry.
    return result;
  }

  if (history.length === 0) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastSyncedAt: new Date() },
    });
    const result: SyncResult = { persisted: 0, triggeredOnInbound: false, cached: false };
    cache.set(conversationId, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
  }

  // Persist new inbound messages via the same shape `tg-listen` writes.
  // Outbound rows from history are skipped — we never want to overwrite
  // our own bookkeeping for what we sent (status, suggestionId binding,
  // operatorId). The persistence is one tx so the conversation either
  // sees all the new messages or none, mirroring how an atomic batch
  // arrives from the push path.
  const ascending = [...history]
    .filter((h) => !h.out) // inbound only — see comment above
    .sort((a, b) => Number(a.tgMsgId) - Number(b.tgMsgId));

  // Pre-filter against existing tgMsgId rows so the create loop doesn't
  // hit unique-violation errors mid-tx (which would abort the whole tx).
  const existing = await prisma.message.findMany({
    where: {
      conversationId: conv.id,
      tgMsgId: { in: ascending.map((m) => m.tgMsgId) },
    },
    select: { tgMsgId: true },
  });
  const existingIds = new Set(existing.map((e) => e.tgMsgId));
  const fresh = ascending.filter((m) => !existingIds.has(m.tgMsgId));

  if (fresh.length === 0) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastSyncedAt: new Date() },
    });
    const result: SyncResult = { persisted: 0, triggeredOnInbound: false, cached: false };
    cache.set(conversationId, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
  }

  await prisma.$transaction(async (tx) => {
    for (const m of fresh) {
      await tx.message.create({
        data: {
          conversationId: conv.id,
          direction: 'in_',
          sender: 'contact',
          text: m.text,
          status: 'received',
          tgMsgId: m.tgMsgId,
          createdAt: new Date(m.sentAt),
        },
      });
    }
    await tx.conversation.update({
      where: { id: conv.id },
      data: { lastInboundAt: new Date(fresh[fresh.length - 1]!.sentAt), lastSyncedAt: new Date() },
    });
  });

  // Observability — surfaces unhealthy push coverage as a counter the
  // log pipeline can roll up. Each fresh row that we got via sync is a
  // row the push path missed.
  for (const m of fresh) {
    logger.info(
      {
        event: 'tg.message.first_persist_via_sync',
        conversationId: conv.id,
        tgMsgId: m.tgMsgId,
      },
      'conversation-sync persisted message that the push path missed',
    );
  }

  // Realtime push so the inbox UI flips without waiting for refetch.
  // One event per persisted message, mirroring tg-listen's contract.
  // The shared MessageDirection wire shape is `'in'` / `'out'` (no
  // underscore — that's the Prisma DB shape only).
  for (const m of fresh) {
    emitToRoom(`conversation:${conv.id}`, {
      type: 'message.new',
      conversationId: conv.id,
      message: {
        id: m.tgMsgId, // best-effort id for the realtime payload
        direction: 'in',
        sender: 'contact',
        text: m.text,
        createdAt: m.sentAt,
      },
    });
  }

  // Bounded suggestion regeneration: enqueue agent-run on_inbound for
  // the MOST RECENT new inbound only. Older backfilled messages are
  // persisted (so the operator can read them) but don't each spawn LLM
  // work — that would flood the agent-run queue after a long outage.
  const queues = getQueues();
  await queues.agentRun.add('on_inbound', {
    pipeline: 'on_inbound',
    conversationId: conv.id,
    contactId: conv.contactId,
  });

  const result: SyncResult = {
    persisted: fresh.length,
    triggeredOnInbound: true,
    cached: false,
  };
  cache.set(conversationId, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

/**
 * Wrap `syncOne` in a hard time budget. Returns once either sync
 * completes or the budget elapses; in the latter case sync continues
 * in the background — newly-persisted messages still flow to the UI
 * via realtime.
 */
export async function syncOneWithBudget(
  conversationId: string,
  budgetMs = 1500,
): Promise<{ done: boolean; result?: SyncResult }> {
  let resolved = false;
  const work = syncOne(conversationId).then((r) => {
    if (!resolved) return r;
    return r;
  });
  const timeout = new Promise<{ timeout: true }>((resolve) => {
    setTimeout(() => resolve({ timeout: true }), budgetMs);
  });
  const race = await Promise.race([
    work.then((r) => ({ kind: 'done' as const, r })),
    timeout.then(() => ({ kind: 'timeout' as const })),
  ]);
  if (race.kind === 'done') {
    resolved = true;
    return { done: true, result: race.r };
  }
  // Budget hit — keep the work running in background. Log on completion
  // so we know whether stale GETs eventually catch up.
  void work
    .then((r) => {
      logger.info(
        {
          event: 'conversation_sync.completed_after_budget',
          conversationId,
          persisted: r.persisted,
          triggeredOnInbound: r.triggeredOnInbound,
        },
        'conversation-sync completed in background after time budget',
      );
    })
    .catch((err) => {
      logger.warn(
        {
          event: 'conversation_sync.background_failed',
          conversationId,
          err: (err as Error).message,
        },
        'conversation-sync background work failed',
      );
    });
  return { done: false };
}
