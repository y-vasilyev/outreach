import { getPrisma } from '@nosquare/db';
import type { z } from 'zod';
import type {
  ContactBulkCreateInputZ,
  ContactCreateInputZ,
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
type CreateInput = z.infer<typeof ContactCreateInputZ>;
type BulkCreateInput = z.infer<typeof ContactBulkCreateInputZ>;

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

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const TG_USER_RE = /^@?([a-zA-Z][\w]{4,31})$/;
const TG_LINK_RE = /^(?:https?:\/\/)?t\.me\/(.+)$/i;
const PHONE_RE = /^\+?\d[\d\s().-]{6,18}$/;
const URL_RE = /^https?:\/\/.+/i;

/**
 * Auto-detect the contact type from a free-form value the operator pasted.
 * Mirrors what `ContactExtractor` does on regex candidates so manual entries
 * line up with extracted ones (same `(type, value)` key, hence dedupe works).
 */
function detectContactType(raw: string): ContactType {
  const t = raw.trim();
  if (!t) return 'other';
  if (EMAIL_RE.test(t)) return 'email';
  if (TG_LINK_RE.test(t)) {
    // t.me/username → tg_username; t.me/+abc, t.me/joinchat/… → tg_link
    const tail = t.replace(TG_LINK_RE, '$1');
    if (/^[a-zA-Z][\w]{4,31}$/.test(tail)) return 'tg_username';
    return 'tg_link';
  }
  if (TG_USER_RE.test(t)) return 'tg_username';
  if (PHONE_RE.test(t)) return 'tg_phone';
  if (URL_RE.test(t)) return 'website';
  return 'other';
}

/**
 * Normalise the value to the same canonical form as the extractor uses, so the
 * `(channelId, type, value)` unique key dedupes manual + extracted entries.
 */
function normalizeContactValue(type: ContactType, raw: string): string {
  const t = raw.trim();
  switch (type) {
    case 'tg_username': {
      const m = t.match(/^(?:@|https?:\/\/t\.me\/)?([a-zA-Z][\w]{4,31})$/);
      return m?.[1] ? m[1].toLowerCase() : t.replace(/^@/, '').toLowerCase();
    }
    case 'tg_link':
      return t.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    case 'tg_phone':
      return t.startsWith('+')
        ? `+${t.slice(1).replace(/\D/g, '')}`
        : `+${t.replace(/\D/g, '')}`;
    case 'email':
      return t.toLowerCase();
    case 'website':
    case 'web_form':
      return t.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    default:
      return t;
  }
}

/**
 * Reachability follows the type: TG-channel types are reachable via outreach,
 * everything else is operator-handled (manual outreach via inbox).
 */
function reachabilityForType(type: ContactType): 'reachable_tg' | 'manual' | 'unreachable' {
  if (type === 'tg_username' || type === 'tg_link' || type === 'tg_phone') return 'reachable_tg';
  if (type === 'email' || type === 'website' || type === 'web_form') return 'manual';
  return 'unreachable';
}

export const contactsService = {
  async list(filters: Filters & { limit?: number }) {
    const prisma = getPrisma();
    const rows = await prisma.contact.findMany({
      where: {
        ...(filters.channelId && { channelId: filters.channelId }),
        // `cold=true` → only cold leads; `cold=false` → only channel-bound.
        ...(filters.cold === true && { channelId: null }),
        ...(filters.cold === false && { channelId: { not: null } }),
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
        channel: { select: { id: true, handle: true, platform: true, title: true, description: true } },
      },
      orderBy: { createdAt: 'desc' },
      // Default 1000 (was 200) so the contacts page can "select all" across
      // a typical operator workload without silently truncating. Schema
      // enforces a 5000 hard ceiling.
      take: filters.limit ?? 1000,
    });
    // Prisma serialises `Decimal` columns as strings on the wire. Wire
    // contract (and the UI) expects a number (0..1).
    return rows.map((r) => ({ ...r, confidence: Number(r.confidence) }));
  },

  /**
   * Operator hand-creates a single contact on a channel. We mark it
   * `extractedBy='manual'` so the contact-extract worker's upsert won't
   * overwrite it on a re-run, and default confidence to 1.0 (the operator
   * is asserting this is a real, hand-curated contact). Reachability is
   * derived from the type.
   *
   * The unique constraint `(channelId, type, value)` already enforces dedupe;
   * we surface a friendlier 409 instead of letting Prisma raise P2002.
   */
  async create(input: CreateInput) {
    const prisma = getPrisma();

    const channelId = input.channelId ?? null;
    if (channelId) {
      const ch = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true },
      });
      if (!ch) throw Errors.notFound('channel', channelId);
    }

    const type = input.type ?? detectContactType(input.value);
    const value = normalizeContactValue(type, input.value);
    if (!value) throw Errors.badRequest('contact value is empty after normalisation');

    // Pre-flight dedupe so we surface a friendly 409. Channel-bound rows use
    // the (channelId, type, value) unique key; cold leads (channelId NULL)
    // use the partial unique index `Contact_type_value_no_channel_key`.
    const existing = channelId
      ? await prisma.contact.findUnique({
          where: { channelId_type_value: { channelId, type, value } },
          select: { id: true },
        })
      : await prisma.contact.findFirst({
          where: { channelId: null, type, value },
          select: { id: true },
        });
    if (existing) {
      throw Errors.conflict(
        `contact already exists${channelId ? ' on this channel' : ' as cold lead'} (${type}=${value}) — id=${existing.id}`,
      );
    }

    const row = await prisma.contact.create({
      data: {
        channelId,
        type,
        value,
        rawValue: input.value,
        label: input.label ?? null,
        roleGuess: input.roleGuess ?? 'unknown',
        confidence: input.confidence ?? 1,
        extractedBy: 'manual',
        reachability: reachabilityForType(type),
        status: input.status ?? 'new',
        tags: input.tags ?? [],
      },
    });
    return { ...row, confidence: Number(row.confidence) };
  },

  /**
   * Batch variant. Same semantics as `create`, but tolerant to per-row
   * failures: each item that already exists or normalises to empty is
   * counted in `skipped`; created rows are returned. The shape mirrors
   * `channelsService.import` so the UI can use the same toast pattern.
   */
  async bulkCreate(input: BulkCreateInput): Promise<{
    accepted: number;
    skipped: number;
    created: { id: string; type: ContactType; value: string }[];
    errors: { input: string; reason: string }[];
  }> {
    const prisma = getPrisma();

    const channelId = input.channelId ?? null;
    if (channelId) {
      const ch = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true },
      });
      if (!ch) throw Errors.notFound('channel', channelId);
    }

    const defaults = input.defaults ?? {};
    const created: { id: string; type: ContactType; value: string }[] = [];
    const errors: { input: string; reason: string }[] = [];
    let skipped = 0;

    for (const it of input.items) {
      const isStr = typeof it === 'string';
      const rawValue = isStr ? it : it.value;
      const explicitType = isStr ? defaults.type : (it.type ?? defaults.type);
      const type = explicitType ?? detectContactType(rawValue);
      const value = normalizeContactValue(type, rawValue);
      if (!value) {
        skipped += 1;
        errors.push({ input: rawValue, reason: 'empty after normalisation' });
        continue;
      }
      try {
        const row = await prisma.contact.create({
          data: {
            channelId,
            type,
            value,
            rawValue,
            label: isStr ? null : (it.label ?? null),
            roleGuess: (isStr ? defaults.roleGuess : (it.roleGuess ?? defaults.roleGuess)) ?? 'unknown',
            confidence:
              (isStr ? defaults.confidence : (it.confidence ?? defaults.confidence)) ?? 1,
            extractedBy: 'manual',
            reachability: reachabilityForType(type),
            status: (isStr ? defaults.status : (it.status ?? defaults.status)) ?? 'new',
            tags: defaults.tags ?? [],
          },
        });
        created.push({ id: row.id, type, value });
      } catch (e) {
        // Prisma P2002 → either the channel-bound unique
        // (channelId, type, value) or the partial cold-lead unique
        // (type, value WHERE channelId IS NULL) tripped — same outcome
        // either way: dedupe, not error.
        const code = (e as { code?: string }).code;
        if (code === 'P2002') {
          skipped += 1;
          errors.push({
            input: rawValue,
            reason: channelId ? 'duplicate on this channel' : 'duplicate cold lead',
          });
        } else {
          skipped += 1;
          errors.push({ input: rawValue, reason: (e as Error).message ?? 'create failed' });
        }
      }
    }

    return { accepted: created.length, skipped, created, errors };
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
    // Cold leads aren't tied to a channel — there's nothing for the
    // contact-extract worker to re-run against. Surface this as a clean 400
    // so the UI can hide / disable the action rather than 500.
    if (!c.channelId) {
      throw Errors.badRequest(
        'cold leads are not tied to a channel — re-extract is not applicable',
      );
    }

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
      scheduledAt?: string;
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
    // into `meta` so agent-run can pick them up. `outreachStartAt` gates
    // auto-send only; suggestions are still generated immediately.
    if ((!opts.campaignId && (opts.goalText || opts.valueProp)) || opts.scheduledAt) {
      const currentMeta = conv.meta && typeof conv.meta === 'object'
        ? (conv.meta as Record<string, unknown>)
        : {};
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          meta: {
            ...currentMeta,
            ...(!opts.campaignId && (opts.goalText || opts.valueProp)
              ? {
                  adHoc: {
                    goalText: opts.goalText ?? '',
                    valueProp: opts.valueProp ?? '',
                  },
                }
              : {}),
            ...(opts.scheduledAt ? { outreachStartAt: opts.scheduledAt } : {}),
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
