import { getPrisma } from '@nosquare/db';
import {
  buildHudTargetRow,
  Errors,
  getSuggestionTargetField,
  resolveEffectiveHudTargets,
  type HudTargetRow,
} from '@nosquare/shared';

import { logger } from '../logger.js';

/**
 * Data-collection HUD (data-collection-hud-target-fields change, Phase 1).
 *
 * Joins, on read, the conversation's effective target list with:
 *   - the linked channel's `ProfileDataPoint` rows (one source of "answered"),
 *   - the conversation's suggestions whose `meta.targetField` is set (the
 *     source of "asked"),
 *   - per-target freshness computed locally from the matching subset (so
 *     `geo` and `audience_demographics` stay independent even though both
 *     map to the same broader freshness section).
 *
 * No write path. The endpoint is read-only and re-derives on each request;
 * the `dataCollectionUpdated` WS event drives in-place patching in the
 * web client so we do not need to cache.
 */

export interface HudResponse {
  campaignTypeKey: string | null;
  targets: HudTargetRow[];
}

interface DataPointRow {
  field: string;
  value: unknown;
  capturedAt: Date | null;
  sourceMessageId: string | null;
}

export const dataCollectionHudService = {
  async get(conversationId: string): Promise<HudResponse> {
    const prisma = getPrisma();

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        contact: {
          select: {
            channelId: true,
          },
        },
        campaign: {
          select: {
            goal: true,
            type: { select: { key: true } },
          },
        },
      },
    });
    if (!conversation) throw Errors.notFound('conversation', conversationId);

    const campaignTypeKey = conversation.campaign?.type?.key ?? null;

    // No campaign → empty HUD. The registry helper would fall back to the
    // agency default set otherwise, which is wrong for typeless / CustDev
    // conversations that don't run the planner at all.
    if (!conversation.campaign) {
      return { campaignTypeKey, targets: [] };
    }

    const targets = resolveEffectiveHudTargets(conversation.campaign, (unknownKey) => {
      logger.warn(
        {
          event: 'data_collection_hud.unknown_target_key',
          conversationId,
          key: unknownKey,
        },
        'data-collection HUD: dropping unknown campaign.goal.target_data_points key',
      );
    });

    if (targets.length === 0) {
      return { campaignTypeKey, targets: [] };
    }

    const channelId = conversation.contact?.channelId ?? null;

    // Load the channel's profile points in one query (small per-blogger set).
    let dataPoints: DataPointRow[] = [];
    if (channelId) {
      const profile = await prisma.bloggerProfile.findUnique({
        where: { channelId },
        select: {
          dataPoints: {
            select: {
              field: true,
              value: true,
              capturedAt: true,
              sourceMessageId: true,
            },
          },
        },
      });
      if (profile) {
        dataPoints = profile.dataPoints.map((dp) => ({
          field: dp.field,
          value: dp.value,
          capturedAt: dp.capturedAt,
          sourceMessageId: dp.sourceMessageId,
        }));
      }
    }

    // Conversation-scoped suggestions with a meta.targetField, grouped by
    // target key with the most-recent createdAt. Order desc so the first
    // hit per key is the latest ask.
    const suggestions = await prisma.suggestion.findMany({
      where: { conversationId },
      select: { meta: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const lastAskedByTarget = new Map<string, Date>();
    for (const sug of suggestions) {
      const tf = getSuggestionTargetField(sug);
      if (!tf) continue;
      if (lastAskedByTarget.has(tf)) continue;
      lastAskedByTarget.set(tf, sug.createdAt);
    }

    const hudTargets: HudTargetRow[] = targets.map((target) =>
      buildHudTargetRow(
        target,
        dataPoints.map((dp) => ({
          field: dp.field,
          value: dp.value,
          capturedAt: dp.capturedAt,
          sourceMessageId: dp.sourceMessageId,
        })),
        lastAskedByTarget.get(target.key) ?? null,
      ),
    );

    return { campaignTypeKey, targets: hudTargets };
  },
};
