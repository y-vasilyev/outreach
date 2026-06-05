import { Worker, Queue } from 'bullmq';
import { getFeatureFlags } from '../feature-flags.js';
import { getRedis } from '../redis.js';
import { TgListenJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { getTgClient } from '../services/tg-client.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';
import { persistInboundMedia } from '../services/media-store.js';

let _agentRunQueue: Queue | undefined;
function agentRunQueue(): Queue {
  if (!_agentRunQueue) {
    _agentRunQueue = new Queue(QueueNames.agentRun, { connection: getRedis() });
  }
  return _agentRunQueue;
}

/**
 * Worker that consumes `tg-listen` jobs produced by `startTgListenSubscribers`.
 * For each incoming TG message we:
 *   1. resolve the contact (`tgUserId` first, then `value === '@'+username`),
 *   2. find or create the conversation against the receiving outreach account,
 *   3. write the inbound `Message`,
 *   4. update `lastInboundAt`,
 *   5. emit realtime `message.new`,
 *   6. enqueue an `agent-run` job with `pipeline: 'on_inbound'` so the
 *      ReplyComposer/SafetyFilter pipeline produces suggestions.
 *
 * Idempotent against duplicate deliveries via `tgMsgId` uniqueness check.
 */
export function startTgListenWorker() {
  const worker = new Worker(
    QueueNames.tgListen,
    async (job) => {
      const data = TgListenJobZ.parse(job.data);
      const prisma = getPrisma();
      logger.info(
        {
          jobId: job.id,
          fromTgUserId: data.fromTgUserId,
          tgAccountId: data.tgAccountId,
          fromUsername: data.fromUsername ?? null,
          tgMsgId: data.tgMsgId,
        },
        'tg-listen: processing inbound job',
      );

      // 1. Resolve contact. Strict tgUserId lookup first — that's what tg-send
      // now persists on first outbound. For contacts that were messaged
      // *before* the resolve-on-send fix landed (so tgUserId is empty),
      // fall back to matching by username taken straight off the GramJS
      // event payload. We can't call `users.GetUsers` here because GramJS
      // has no access_hash for these "stale" users (the call throws
      // "Could not find the input entity"). The username from the inline
      // sender entity is reliable when present. On hit we back-fill
      // tgUserId + profile fields so future inbounds use the fast path.
      let conv = await prisma.conversation.findFirst({
        where: {
          tgAccountId: data.tgAccountId,
          contact: { tgUserId: data.fromTgUserId },
        },
        include: { contact: true },
        orderBy: { updatedAt: 'desc' },
      });

      if (!conv && data.fromUsername) {
        const username = data.fromUsername.toLowerCase();
        conv = await prisma.conversation.findFirst({
          where: {
            tgAccountId: data.tgAccountId,
            contact: {
              type: 'tg_username',
              OR: [
                { tgUsername: { equals: username, mode: 'insensitive' } },
                { value: { equals: username, mode: 'insensitive' } },
              ],
            },
          },
          include: { contact: true },
          orderBy: { updatedAt: 'desc' },
        });
      }

      let contact = conv?.contact ?? await prisma.contact.findFirst({
        where: { tgUserId: data.fromTgUserId },
      });

      if (!contact && data.fromUsername) {
        const username = data.fromUsername.toLowerCase();
        contact = await prisma.contact.findFirst({
          where: {
            type: 'tg_username',
            OR: [
              { tgUsername: { equals: username, mode: 'insensitive' } },
              { value: { equals: username, mode: 'insensitive' } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
        });
        if (contact) {
          contact = await prisma.contact.update({
            where: { id: contact.id },
            data: {
              tgUserId: data.fromTgUserId,
              tgUsername: data.fromUsername,
              tgFirstName: data.fromFirstName ?? null,
              tgLastName: data.fromLastName ?? null,
              ...(data.fromAccessHash ? { tgAccessHash: data.fromAccessHash } : {}),
            },
          });
          logger.info(
            { contactId: contact.id, username, fromTgUserId: data.fromTgUserId },
            'tg-listen: back-filled tgUserId from inline sender username',
          );
        }
      }

      // Refresh tgAccessHash on every inbound when present — the value is
      // stable per (account_pair) but the local row may be empty (legacy
      // contacts) or stale (rare account migrations). Cheap upsert keeps the
      // explicit-InputPeerUser path on the latest hash.
      if (contact && data.fromAccessHash && contact.tgAccessHash !== data.fromAccessHash) {
        contact = await prisma.contact.update({
          where: { id: contact.id },
          data: { tgAccessHash: data.fromAccessHash },
        });
      }

      if (!contact) {
        logger.info(
          {
            fromTgUserId: data.fromTgUserId,
            fromUsername: data.fromUsername ?? null,
            fromFirstName: data.fromFirstName ?? null,
            tgAccountId: data.tgAccountId,
          },
          'inbound message has no matching contact; dropping',
        );
        return { ok: true, skipped: 'no contact' };
      }

      // 2. Find or create the conversation.
      if (!conv) {
        conv = await prisma.conversation.findUnique({
          where: {
            tgAccountId_contactId: {
              tgAccountId: data.tgAccountId,
              contactId: contact.id,
            },
          },
          include: { contact: true },
        });
      }
      if (!conv) {
        // No campaign context at this point — the inbound is from a
        // contact that never had a conversation with this account
        // before. We can't propagate `Campaign.defaultMode` because
        // we don't know which campaign (if any) this contact belongs
        // to. Default to `assisted` so the operator drives the first
        // turn; subsequent operator actions or campaign binds (e.g.
        // contacts.startConversation) can change the mode.
        conv = await prisma.conversation.create({
          data: {
            tgAccountId: data.tgAccountId,
            contactId: contact.id,
            status: 'active',
            mode: 'assisted',
          },
          include: { contact: true },
        });
      }

      // Surface media-only inbounds (no caption) to the operator even when
      // ENABLE_OBJECT_STORAGE is off: we persist the Message + attachments
      // metadata so the chat shows a media placeholder bubble. Only the
      // S3 byte upload (persistInboundMedia below) stays gated behind the
      // flag — dropping silently is worse than a placeholder.

      // 3. Idempotency: skip if we already stored this tgMsgId for this conv.
      if (data.tgMsgId) {
        const dup = await prisma.message.findFirst({
          where: { conversationId: conv.id, tgMsgId: data.tgMsgId },
          select: { id: true },
        });
        if (dup) return { ok: true, skipped: 'duplicate' };
      }

      const attachments = data.media
        ? [
            {
              kind: data.media.kind,
              ...(data.media.mime ? { mime: data.media.mime } : {}),
              ...(data.media.fileName ? { fileName: data.media.fileName } : {}),
              ...(typeof data.media.bytes === 'number' ? { bytes: data.media.bytes } : {}),
            },
          ]
        : [];

      const message = await prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: 'in_',
          sender: 'contact',
          text: data.text,
          attachments,
          status: 'received',
          tgMsgId: data.tgMsgId || null,
        },
      });

      // 3b. Inbound media → S3 + media_asset (agency-sourcing-matching M6).
      // Behind ENABLE_OBJECT_STORAGE; degrades safely (logs + continues) so
      // media never blocks inbound processing or drops the conversation.
      if (data.media && getFeatureFlags().get('object_storage')) {
        await persistInboundMedia({
          conversationId: conv.id,
          channelId: contact.channelId ?? null,
          sourceTgMsgId: data.tgMsgId || null,
          messageId: message.id,
          media: data.media,
          // B3: download the actual bytes via tg-client (GramJS downloadMedia)
          // so the media_asset gets a real s3Key. The thunk resolves to null on
          // any failure → media-store records an honest-pending (empty s3Key)
          // row instead of a dead URL. Never throws (guarded both sides).
          downloadBytes: async () => {
            if (!data.tgMsgId) return null;
            const tg = getTgClient();
            if (!tg) return null;
            try {
              const handle = await tg.for(data.tgAccountId);
              return await handle.downloadInboundMedia({
                peerKey: data.fromTgUserId,
                tgMsgId: data.tgMsgId,
              });
            } catch (err) {
              logger.warn(
                { conversationId: conv.id, err: (err as Error).message },
                'tg-listen: media byte download failed; honest-pending asset',
              );
              return null;
            }
          },
        }).catch((err) => {
          logger.warn(
            { conversationId: conv.id, err: (err as Error).message },
            'tg-listen: media persistence threw; ignoring (inbound continues)',
          );
          return undefined;
        });
      } else if (data.media) {
        logger.warn(
          { conversationId: conv.id, mediaClass: data.media.className },
          'tg-listen: inbound media present but object storage disabled; skipping',
        );
      }

      // 4. Touch `lastInboundAt` and bring the conversation back to active
      // (in case it was closed/paused).
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { lastInboundAt: new Date(data.receivedAt) },
      });

      // 5. Realtime push to anyone watching this conversation, and to the
      // campaign room so the filtered inbox list can bubble fresh replies
      // without waiting for polling.
      const messageEvent = {
        type: 'message.new',
        conversationId: conv.id,
        message: {
          id: message.id,
          direction: 'in',
          sender: 'contact',
          text: message.text,
          attachments,
          createdAt: message.createdAt.toISOString(),
        },
      } as const;
      await publishRealtime(`conversation:${conv.id}`, messageEvent);
      if (conv.campaignId) {
        await publishRealtime(`campaign:${conv.campaignId}`, messageEvent);
      }
      logger.info(
        { conversationId: conv.id, messageId: message.id },
        'tg-listen: published message.new to realtime',
      );

      // 6. Trigger the on_inbound agent pipeline (intent → handoff → reply
      // → safety → suggestion). agent-run reads the latest inbound from
      // history, so we don't need to pass the messageId explicitly.
      await agentRunQueue().add('on_inbound', {
        pipeline: 'on_inbound',
        conversationId: conv.id,
        contactId: contact.id,
      });

      return { ok: true, conversationId: conv.id, messageId: message.id };
    },
    { connection: getRedis(), concurrency: 4 },
  );

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err?.message }, 'tg-listen failed'),
  );
  return worker;
}

/**
 * Boot-time subscriber: connects to every active outreach/both account and
 * registers an incoming-message handler that enqueues `tg-listen` jobs.
 *
 * The handler doesn't do any DB/agent work itself — it just turns a TG
 * event into a queue job, so a flaky GramJS connection can't lose data
 * (BullMQ retries on failure) and the listener stays light.
 */
const RECONCILE_INTERVAL_MS = 30_000;

/**
 * Bind GramJS `NewMessage` listeners for every healthy outreach/both
 * account, AND keep that set in sync over time. Without the periodic
 * reconcile, accounts added or logged-in after worker boot never get a
 * listener — the symptom is "outbound works but no inbound ever arrives"
 * because tg-send creates sessions on demand while tg-listen only ran
 * the snapshot taken at boot.
 *
 * Reconcile semantics:
 *   - desired = (role outreach/both) ∧ (status active|idle|cooldown).
 *     Cooldown pauses outbound work, but inbound listening must stay alive:
 *     otherwise contacts can reply during a FloodWait window and the operator
 *     will not see the message until an explicit history sync catches it.
 *   - subscribe any desired account not yet in the registry.
 *   - unsubscribe any registered account no longer in desired (status
 *     flipped to need_auth/banned, deleted, etc.).
 *
 * Initial bind runs in parallel — sequential `tg.for(a.id)` takes ~N
 * seconds for N accounts because GramJS connect is async.
 */
export async function startTgListenSubscribers(): Promise<{ stop: () => Promise<void> }> {
  const prisma = getPrisma();
  const tgClient = getTgClient();
  if (!tgClient) {
    logger.warn('TG client not configured; tg-listen subscribers are disabled');
    return { stop: async () => undefined };
  }
  // Pin into a non-null local so the closures below don't need narrowing.
  const tg = tgClient;

  const queue = new Queue(QueueNames.tgListen, { connection: getRedis() });
  const registry = new Map<string, () => void>();
  // Avoid stacking concurrent bind attempts for the same account when a
  // session is slow to open (>RECONCILE_INTERVAL_MS).
  const inFlight = new Set<string>();
  let stopped = false;

  async function bindOne(a: { id: string; label: string }) {
    if (registry.has(a.id) || inFlight.has(a.id)) return;
    inFlight.add(a.id);
    try {
      const handle = await tg.for(a.id);
      if (!handle.isAuthorized) {
        logger.warn({ tgAccountId: a.id, label: a.label }, 'tg-listen: account not authorized; skipping');
        return;
      }
      if (stopped || registry.has(a.id)) return;
      const unsub = handle.subscribeIncoming(async (msg) => {
        try {
          await queue.add('inbound', msg);
        } catch (err) {
          logger.warn(
            { tgAccountId: a.id, err: (err as Error).message },
            'tg-listen: failed to enqueue job',
          );
        }
      });
      registry.set(a.id, unsub);
      logger.info({ tgAccountId: a.id, label: a.label }, 'tg-listen: subscribed');
    } catch (err) {
      logger.warn(
        { tgAccountId: a.id, err: (err as Error).message },
        'tg-listen: subscribe failed',
      );
    } finally {
      inFlight.delete(a.id);
    }
  }

  async function reconcile() {
    if (stopped) return;
    const accounts = await prisma.tgAccount.findMany({
      where: {
        role: { in: ['outreach', 'both'] },
        status: { in: ['active', 'idle', 'cooldown'] },
      },
      select: { id: true, label: true },
    });
    const desired = new Set(accounts.map((a) => a.id));

    // Drop subscriptions for accounts that left the desired set.
    for (const [id, unsub] of registry) {
      if (!desired.has(id)) {
        try { unsub(); } catch { /* ignore */ }
        registry.delete(id);
        logger.info({ tgAccountId: id }, 'tg-listen: unsubscribed (no longer desired)');
      }
    }

    // Bind new ones in parallel — 200 sequential awaits would take
    // minutes; parallel completes in seconds.
    const fresh = accounts.filter((a) => !registry.has(a.id) && !inFlight.has(a.id));
    if (fresh.length === 0) return;
    await Promise.all(fresh.map(bindOne));
  }

  // Initial bind. Failures are logged inside bindOne; never block boot
  // on a slow account.
  await reconcile().catch((err) => {
    logger.warn({ err: (err as Error).message }, 'tg-listen: initial reconcile failed');
  });

  const timer = setInterval(() => {
    reconcile().catch((err) => {
      logger.warn({ err: (err as Error).message }, 'tg-listen: reconcile tick failed');
    });
  }, RECONCILE_INTERVAL_MS);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      for (const unsub of registry.values()) {
        try { unsub(); } catch { /* ignore */ }
      }
      registry.clear();
      try { await queue.close(); } catch { /* ignore */ }
    },
  };
}
