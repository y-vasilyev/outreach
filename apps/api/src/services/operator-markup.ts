import { composeOffersForRollup, getPrisma, Prisma } from '@nosquare/db';
import {
  AppError,
  coerceOperatorValue,
  rollUpProfileFields,
  type ExtractionHintInput,
  type ExtractionHintPatch,
  type OperatorDataPointWrite,
  type RollupDataPoint,
} from '@nosquare/shared';
import { getQueues } from '../queues.js';

/**
 * Operator re-analysis + markup service (operator-reanalyze-and-markup).
 * Re-run extraction (supersede), correct/delete profile data points (operator
 * origin, re-rolled), and CRUD operator extraction hints.
 */

/** Re-derive + persist a profile's rolled-up fields from its data points. */
async function rerollProfile(profileId: string): Promise<void> {
  const prisma = getPrisma();
  const points = await prisma.profileDataPoint.findMany({ where: { profileId } });
  const rollupInput: RollupDataPoint[] = points.map((p) => ({
    field: p.field,
    value: p.value,
    unit: p.unit,
    confidence: Number(p.confidence),
    capturedAt: p.capturedAt,
  }));
  // Rows-aware composition (placement-offer-table): without this, an operator
  // edit re-roll would resurrect superseded prices from the raw data points —
  // supersede state lives only on the offer rows (codex review).
  const composed = await composeOffersForRollup(
    prisma,
    profileId,
    points.filter((p) => p.field === 'placement.offer').map((p) => p.id),
  );
  const rolled = rollUpProfileFields(
    rollupInput,
    composed.offers ? { placementOffers: composed.offers } : undefined,
  );
  await prisma.bloggerProfile.update({
    where: { id: profileId },
    data: {
      topics: rolled.topics,
      languages: rolled.languages,
      formats: rolled.formats,
      audience: rolled.audience as never,
      rateCards: rolled.rateCards as never,
      placementOffers: rolled.placementOffers as never,
      platformAudience: rolled.platformAudience as never,
      reach: rolled.reach,
      avgViews: rolled.avgViews,
      capturedAt: rolled.capturedAt ? new Date(rolled.capturedAt) : null,
    },
  });
}

export const operatorMarkupService = {
  /** Enqueue a superseding re-run of profile extraction for one inbound message. */
  async reanalyzeMessage(conversationId: string, messageId: string, supersede: boolean) {
    const prisma = getPrisma();
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true, direction: true },
    });
    if (!message || message.conversationId !== conversationId || message.direction !== 'in_') {
      throw new AppError('NOT_FOUND', 'inbound message not found in this conversation', 404);
    }
    // Reflect immediate progress; the worker will stamp the terminal status.
    await prisma.message.update({
      where: { id: messageId },
      data: { extractionStatus: 'pending', extractionError: null },
    });
    // Plain enqueue (no custom jobId → no BullMQ colon-shape concerns).
    await getQueues().profileExtract.add('reanalyze', {
      conversationId,
      sourceMessageId: messageId,
      supersede,
    });
    return { ok: true, status: 'pending' as const };
  },

  /** Write an operator-origin data point (confidence 1.0) and re-roll. */
  async writeDataPoint(profileId: string, input: OperatorDataPointWrite) {
    const prisma = getPrisma();
    const profile = await prisma.bloggerProfile.findUnique({ where: { id: profileId }, select: { id: true } });
    if (!profile) throw new AppError('NOT_FOUND', 'profile not found', 404);
    const value = coerceOperatorValue(input.field, input.value);
    if (value === undefined) {
      throw new AppError('VALIDATION', `value invalid for field "${input.field}"`, 422);
    }
    const created = await prisma.profileDataPoint.create({
      data: {
        profileId,
        field: input.field.trim(),
        value: (value === null ? Prisma.JsonNull : value) as never,
        unit: input.unit ?? null,
        confidence: 1,
        extractedBy: 'operator',
        sourceMessageId: null,
        rawSnippet: '',
      },
      select: { id: true },
    });
    await rerollProfile(profileId);
    return { ok: true, id: created.id };
  },

  /** Delete a data point (operator correction) and re-roll. */
  async deleteDataPoint(profileId: string, dataPointId: string) {
    const prisma = getPrisma();
    const dp = await prisma.profileDataPoint.findUnique({
      where: { id: dataPointId },
      select: { id: true, profileId: true },
    });
    if (!dp || dp.profileId !== profileId) throw new AppError('NOT_FOUND', 'data point not found', 404);
    await prisma.profileDataPoint.delete({ where: { id: dataPointId } });
    await rerollProfile(profileId);
    return { ok: true };
  },

  async listHints(filter: { channelId?: string; conversationId?: string }) {
    const prisma = getPrisma();
    return prisma.extractionHint.findMany({
      where: {
        ...(filter.channelId ? { channelId: filter.channelId } : {}),
        ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  async createHint(input: ExtractionHintInput, createdById: string | null) {
    const prisma = getPrisma();
    return prisma.extractionHint.create({
      data: {
        scope: input.scope,
        channelId: input.channelId ?? null,
        conversationId: input.conversationId ?? null,
        targetField: input.targetField ?? null,
        guidance: input.guidance,
        exampleInput: input.exampleInput ?? null,
        exampleOutput: input.exampleOutput ?? null,
        active: input.active,
        createdById,
      },
    });
  },

  async updateHint(id: string, patch: ExtractionHintPatch) {
    const prisma = getPrisma();
    const existing = await prisma.extractionHint.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new AppError('NOT_FOUND', 'hint not found', 404);
    return prisma.extractionHint.update({
      where: { id },
      data: {
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
        ...(patch.channelId !== undefined ? { channelId: patch.channelId } : {}),
        ...(patch.conversationId !== undefined ? { conversationId: patch.conversationId } : {}),
        ...(patch.targetField !== undefined ? { targetField: patch.targetField } : {}),
        ...(patch.guidance !== undefined ? { guidance: patch.guidance } : {}),
        ...(patch.exampleInput !== undefined ? { exampleInput: patch.exampleInput } : {}),
        ...(patch.exampleOutput !== undefined ? { exampleOutput: patch.exampleOutput } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      },
    });
  },

  async deleteHint(id: string) {
    const prisma = getPrisma();
    await prisma.extractionHint.delete({ where: { id } }).catch(() => {
      throw new AppError('NOT_FOUND', 'hint not found', 404);
    });
    return { ok: true };
  },
};
