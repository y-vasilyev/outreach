import { getPrisma } from '@nosquare/db';
import type { z } from 'zod';
import type {
  ContactFiltersZ,
  ContactStatusZ,
  ContactTypeZ,
  RoleGuessZ,
} from '@nosquare/shared';
import { Errors } from '@nosquare/shared';
import { getQueues } from '../queues.js';

type Filters = z.infer<typeof ContactFiltersZ>;
type Status = z.infer<typeof ContactStatusZ>;
type RoleGuess = z.infer<typeof RoleGuessZ>;
type ContactType = z.infer<typeof ContactTypeZ>;

interface UpdatePatch {
  status?: Status;
  tags?: string[];
  roleGuess?: RoleGuess;
  confidence?: number;
  value?: string;
  label?: string | null;
  type?: ContactType;
}

const OVERRIDE_KEYS = ['roleGuess', 'confidence', 'value', 'label', 'type'] as const;

export const contactsService = {
  async list(filters: Filters & { limit?: number }) {
    const prisma = getPrisma();
    const rows = await prisma.contact.findMany({
      where: {
        ...(filters.channelId && { channelId: filters.channelId }),
        ...(filters.type && { type: filters.type }),
        ...(filters.roleGuess && { roleGuess: filters.roleGuess }),
        ...(filters.reachability && { reachability: filters.reachability }),
        ...(filters.status && { status: filters.status }),
        ...(filters.q && {
          OR: [
            { value: { contains: filters.q, mode: 'insensitive' } },
            { rawValue: { contains: filters.q, mode: 'insensitive' } },
          ],
        }),
      },
      include: {
        channel: { select: { id: true, handle: true, platform: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 200,
    });
    // Prisma serialises `Decimal` columns as strings on the wire. Wire
    // contract (and the UI) expects a number (0..1).
    return rows.map((r) => ({ ...r, confidence: Number(r.confidence) }));
  },

  async update(id: string, patch: UpdatePatch) {
    const prisma = getPrisma();
    const isOverride = OVERRIDE_KEYS.some((k) => patch[k] !== undefined);
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.roleGuess !== undefined) data.roleGuess = patch.roleGuess;
    if (patch.confidence !== undefined) data.confidence = patch.confidence;
    if (patch.value !== undefined) data.value = patch.value;
    if (patch.label !== undefined) data.label = patch.label;
    if (patch.type !== undefined) data.type = patch.type;
    // Any operator-driven content edit flips provenance to `manual`. The
    // contact-extract worker honours this when re-running so we don't
    // clobber human corrections.
    if (isOverride) data.extractedBy = 'manual';

    const row = await prisma.contact.update({ where: { id }, data });
    return { ...row, confidence: Number(row.confidence) };
  },

  async draft(id: string) {
    const prisma = getPrisma();
    const c = await prisma.contact.findUnique({
      where: { id },
      include: { channel: true },
    });
    if (!c) throw Errors.notFound('contact', id);
    // Latest manual-outreach suggestion goes through the conversation it
    // belongs to; for contacts without a conversation we just return
    // whatever the channel has.
    const conv = await prisma.conversation.findFirst({
      where: { contactId: id },
      orderBy: { createdAt: 'desc' },
    });
    let text = '';
    if (conv) {
      const sug = await prisma.suggestion.findFirst({
        where: { conversationId: conv.id, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      text = sug?.text ?? '';
    }
    return {
      text,
      channel: c.channel
        ? { title: c.channel.title, description: c.channel.description }
        : undefined,
      analysis: c.channel?.analysis ?? undefined,
    };
  },

  /**
   * Enqueue a fresh `contact-extract` job on the contact's parent channel.
   * Returns the job id so the UI can show a toast; the worker upserts so
   * everything (including this contact) gets refreshed except rows already
   * marked `extractedBy: 'manual'`.
   */
  async reExtract(contactId: string): Promise<{ ok: true; jobId: string; channelId: string }> {
    const prisma = getPrisma();
    const c = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, channelId: true },
    });
    if (!c) throw Errors.notFound('contact', contactId);

    await prisma.channel.update({
      where: { id: c.channelId },
      data: { status: 'extracting', lastError: null },
    });

    const queues = getQueues();
    const job = await queues.contactExtract.add('extract', { channelId: c.channelId });
    return { ok: true, jobId: job.id ?? 'unknown', channelId: c.channelId };
  },

  /**
   * Bypass the campaign-dispatcher tick and start a one-off conversation
   * with this contact right now. Either pin to an existing campaign (we
   * pull goal/value/mode from it) or pass them inline. The opener is
   * generated asynchronously by `agent-run` (`outreach_first_message`),
   * so the call returns as soon as the conversation row exists and the
   * job is queued — the operator can refresh the inbox to watch the
   * suggestions land.
   */
  async startConversation(
    contactId: string,
    opts: {
      tgAccountId: string;
      campaignId?: string;
      goalText?: string;
      valueProp?: string;
      mode?: 'auto' | 'assisted' | 'manual';
    },
  ): Promise<{ ok: true; conversationId: string; created: boolean }> {
    const prisma = getPrisma();
    const c = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, value: true, type: true, reachability: true },
    });
    if (!c) throw Errors.notFound('contact', contactId);
    if (c.reachability !== 'reachable_tg') {
      throw Errors.badRequest(
        'contact is not reachable via Telegram (use manual outreach instead)',
      );
    }

    const acct = await prisma.tgAccount.findUnique({
      where: { id: opts.tgAccountId },
      select: { id: true, status: true, role: true },
    });
    if (!acct) throw Errors.notFound('tg-account', opts.tgAccountId);
    if (acct.status !== 'active') {
      throw Errors.badRequest(`tg-account is ${acct.status}; pick an active one`);
    }
    if (acct.role !== 'outreach' && acct.role !== 'both') {
      throw Errors.badRequest('tg-account is not configured for outreach');
    }

    let mode: 'auto' | 'assisted' | 'manual' = opts.mode ?? 'assisted';
    if (opts.campaignId) {
      const cmp = await prisma.campaign.findUnique({
        where: { id: opts.campaignId },
        select: { defaultMode: true },
      });
      if (!cmp) throw Errors.notFound('campaign', opts.campaignId);
      if (!opts.mode) mode = cmp.defaultMode;
    }

    // Upsert keeps this idempotent: clicking "Start chat" twice on the
    // same contact + tg-account just refreshes the campaign binding and
    // re-queues the opener.
    const existing = await prisma.conversation.findUnique({
      where: {
        tgAccountId_contactId: { tgAccountId: opts.tgAccountId, contactId },
      },
      select: { id: true },
    });

    const conv = await prisma.conversation.upsert({
      where: {
        tgAccountId_contactId: { tgAccountId: opts.tgAccountId, contactId },
      },
      update: {
        ...(opts.campaignId !== undefined && { campaignId: opts.campaignId ?? null }),
        mode,
        status: 'active',
      },
      create: {
        tgAccountId: opts.tgAccountId,
        contactId,
        campaignId: opts.campaignId ?? null,
        mode,
        status: 'active',
      },
    });

    // If the operator passed inline goal/value (no campaign), tuck them
    // into the conversation `meta` so agent-run can pick them up. (We do
    // this rather than mutating an existing Campaign — the goal here is
    // a one-off chat, not a campaign edit.) Today the agent-run pipeline
    // pulls from the linked campaign; until that path consumes meta the
    // inline fields just live there for audit.
    if (!opts.campaignId && (opts.goalText || opts.valueProp)) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          meta: {
            adHoc: {
              goalText: opts.goalText ?? '',
              valueProp: opts.valueProp ?? '',
            },
          } as object,
        },
      });
    }

    const queues = getQueues();
    await queues.agentRun.add('outreach_first_message', {
      pipeline: 'outreach_first_message',
      conversationId: conv.id,
      contactId,
      ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
    });

    return { ok: true, conversationId: conv.id, created: !existing };
  },
};
