import { Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import {
  ProfileExtractJobZ,
  QueueNames,
  rollUpProfileFields,
  type ProfileDataPointDraft,
  type RollupDataPoint,
} from '@nosquare/shared';
import { getPrisma, Prisma } from '@nosquare/db';
import { logger } from '../logger.js';
import { runAgentSafe } from '../services/run-agent-safe.js';

interface ExtractionOut {
  data_points: ProfileDataPointDraft[];
  note?: string;
}

/**
 * profile-extract worker (agency-sourcing-matching M5, task 5.2).
 *
 * Loads a conversation + its inbound messages, runs the two extractor agents
 * (rate_card_extractor + audience_stats_extractor) via AgentRunner, persists
 * each emitted draft as a `profile_data_point` linked to the channel's
 * `blogger_profile` (created on first sight, keyed by channelId), and then
 * re-derives the standardized profile via the deterministic roll-up.
 *
 * Triggered for agency_sourcing conversations from the on_inbound handler
 * (behind ENABLE_AGENCY_SOURCING) and on demand via the queue. Errors degrade
 * gracefully — extraction is advisory; it never blocks the inbound pipeline.
 */
export async function handleProfileExtract(data: {
  conversationId?: string;
  sourceMessageId?: string;
}): Promise<unknown> {
  const prisma = getPrisma();
  if (!data.conversationId) throw new Error('conversationId required');

  const conv = await prisma.conversation.findUnique({
    where: { id: data.conversationId },
    include: { contact: { include: { channel: true } } },
  });
  if (!conv) throw new Error('conversation not found');

  const channelId = conv.contact.channelId ?? conv.contact.channel?.id ?? null;
  if (!channelId) {
    // Without a channel we have nothing to key a catalog profile on. The
    // contact may be a bare TG user with no scraped channel.
    return { ok: true, skipped: 'no_channel' };
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: conv.id, direction: 'in_' },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  if (messages.length === 0) return { ok: true, skipped: 'no_inbound' };

  // The message we attribute the data points to. Prefer the explicit one from
  // the job (the inbound that triggered extraction), else the latest inbound.
  const sourceMessageId =
    data.sourceMessageId ?? messages[messages.length - 1]?.id ?? null;

  const replies = messages.map((m) => m.text).filter((t): t is string => Boolean(t));
  const channelTitle = conv.contact.channel?.title ?? '';
  const language = conv.contact.channel?.language ?? 'ru';
  const extractorInput = {
    replies,
    last_inbound: replies[replies.length - 1] ?? '',
    channel_title: channelTitle,
    language,
  };

  const [rate, audience] = await Promise.all([
    runAgentSafe<ExtractionOut>('rate_card_extractor', extractorInput, {
      conversationId: conv.id,
      channelId,
    }),
    runAgentSafe<ExtractionOut>('audience_stats_extractor', extractorInput, {
      conversationId: conv.id,
      channelId,
    }),
  ]);

  const drafts: Array<{ extractedBy: string; draft: ProfileDataPointDraft }> = [];
  for (const dp of rate?.data_points ?? []) {
    drafts.push({ extractedBy: 'rate_card_extractor', draft: dp });
  }
  for (const dp of audience?.data_points ?? []) {
    drafts.push({ extractedBy: 'audience_stats_extractor', draft: dp });
  }

  if (drafts.length === 0) {
    return { ok: true, channelId, dataPoints: 0, degraded: !rate && !audience };
  }

  // Ensure the catalog profile exists (keyed by channelId), then persist all
  // data points and re-roll the standardized fields — in one transaction so a
  // reader never sees data points without the rolled-up view they imply.
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const profile = await tx.bloggerProfile.upsert({
      where: { channelId },
      update: {},
      create: { channelId },
    });

    for (const { extractedBy, draft } of drafts) {
      await tx.profileDataPoint.create({
        data: {
          profileId: profile.id,
          field: draft.field,
          // `value` is a non-nullable Json column; a missing value persists as
          // an explicit JSON null (Prisma.JsonNull) so the row still saves.
          value: (draft.value === undefined ? Prisma.JsonNull : draft.value) as never,
          unit: draft.unit ?? null,
          confidence: draft.confidence,
          extractedBy,
          sourceMessageId,
          rawSnippet: draft.rawSnippet ?? '',
          capturedAt: now,
        },
      });
    }

    const allPoints = await tx.profileDataPoint.findMany({
      where: { profileId: profile.id },
    });
    const rollupInput: RollupDataPoint[] = allPoints.map((p) => ({
      field: p.field,
      value: p.value,
      unit: p.unit,
      confidence: Number(p.confidence),
      capturedAt: p.capturedAt,
    }));
    const rolled = rollUpProfileFields(rollupInput);

    await tx.bloggerProfile.update({
      where: { id: profile.id },
      data: {
        topics: rolled.topics,
        languages: rolled.languages,
        formats: rolled.formats,
        audience: rolled.audience as never,
        rateCards: rolled.rateCards as never,
        reach: rolled.reach,
        avgViews: rolled.avgViews,
        capturedAt: rolled.capturedAt ? new Date(rolled.capturedAt) : null,
      },
    });

    return { profileId: profile.id, dataPointsCreated: drafts.length };
  });

  logger.info(
    {
      event: 'profile.extracted',
      conversationId: conv.id,
      channelId,
      profileId: result.profileId,
      dataPoints: result.dataPointsCreated,
    },
    'blogger profile data points persisted + rolled up',
  );

  return { ok: true, ...result };
}

export function startProfileExtractWorker() {
  const worker = new Worker(
    QueueNames.profileExtract,
    async (job) => {
      const data = ProfileExtractJobZ.parse(job.data);
      return handleProfileExtract(data);
    },
    { connection: getRedis(), concurrency: 2 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err?.message }, 'profile-extract failed'),
  );
  return worker;
}
