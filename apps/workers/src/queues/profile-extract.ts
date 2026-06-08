import { Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import {
  buildHudTargetRow,
  EXTRACTION_HINT_LIMIT,
  getSuggestionTargetField,
  hintsToOperatorStrings,
  PlacementOfferZ,
  preGateExtraction,
  ProfileExtractJobZ,
  QueueNames,
  resolveEffectiveHudTargets,
  rollUpProfileFields,
  stampOfferProvenance,
  targetsForProfileField,
  type DataCollectionTarget,
  type PlacementAttributeProposalDraft,
  type PlacementOfferDraft,
  type ProfileDataPointDraft,
  type RollupDataPoint,
} from '@nosquare/shared';
import { getPrisma, Prisma } from '@nosquare/db';
import { getFeatureFlags } from '../feature-flags.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';
import { runAgentSafe } from '../services/run-agent-safe.js';
import { snapshotRawPayload } from '../services/media-store.js';

interface ExtractionOut {
  data_points: ProfileDataPointDraft[];
  placement_offers?: PlacementOfferDraft[];
  attribute_proposals?: PlacementAttributeProposalDraft[];
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
type ExtractionStatus = 'ok' | 'empty' | 'no_signal' | 'failed';

/**
 * Stamp a message's per-message extraction status + emit the realtime event
 * (operator-reanalyze-and-markup). Best-effort: never throws into the caller.
 * Exported so the synchronous on_inbound caller can stamp `failed` on its catch
 * (the only place a terminal sync failure is observable).
 */
export async function stampExtractionStatus(opts: {
  conversationId: string;
  messageId: string;
  status: ExtractionStatus;
  error?: string | null;
}): Promise<void> {
  const prisma = getPrisma();
  await prisma.message
    .update({
      where: { id: opts.messageId },
      data: {
        extractionStatus: opts.status,
        extractionError: opts.error ?? null,
        extractedAt: new Date(),
      },
    })
    .catch((e) => logger.warn({ err: (e as Error).message }, 'stamp extraction status failed'));
  await publishRealtime(`conversation:${opts.conversationId}`, {
    type: 'message.extraction_status.changed',
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    extractionStatus: opts.status,
    ...(opts.error ? { extractionError: opts.error } : {}),
  }).catch(() => undefined);
}

export async function handleProfileExtract(data: {
  conversationId?: string;
  sourceMessageId?: string;
  supersede?: boolean;
}): Promise<unknown> {
  const prisma = getPrisma();
  if (!data.conversationId) throw new Error('conversationId required');

  const conv = await prisma.conversation.findUnique({
    where: { id: data.conversationId },
    include: {
      contact: { include: { channel: true } },
      // Needed for the data-collection HUD realtime emit (data-collection-
      // hud-target-fields change, Phase 1) — campaign.goal drives the
      // effective target list, campaign.type.key is included in payloads
      // downstream. Cheap join (one row).
      campaign: { select: { goal: true, type: { select: { key: true } } } },
    },
  });
  if (!conv) throw new Error('conversation not found');

  const channelId = conv.contact.channelId ?? conv.contact.channel?.id ?? null;
  if (!channelId) {
    // Without a channel we have nothing to key a catalog profile on. The
    // contact may be a bare TG user with no scraped channel.
    return { ok: true, skipped: 'no_channel' };
  }

  // S1 (provenance): a data point is attributed to the SINGLE inbound message
  // it was extracted from — per-message extraction is the provenance unit. When
  // the job carries `sourceMessageId` (the inbound that triggered this run, the
  // normal path from on_inbound), we extract from THAT message only and
  // attribute every emitted point to it. We do NOT re-run extraction over older
  // history, which would mis-attribute facts mined from prior messages to the
  // latest message's id. Only when no `sourceMessageId` is given (manual/legacy
  // enqueue) do we fall back to the most recent inbound as both input + source.
  let sourceMessage:
    | { id: string; text: string }
    | null = null;
  if (data.sourceMessageId) {
    const m = await prisma.message.findUnique({
      where: { id: data.sourceMessageId },
      select: { id: true, text: true, conversationId: true, direction: true },
    });
    // Guard: the id must be an inbound message of THIS conversation.
    if (m && m.conversationId === conv.id && m.direction === 'in_') {
      sourceMessage = { id: m.id, text: m.text };
    }
  }
  if (!sourceMessage) {
    const latest = await prisma.message.findFirst({
      where: { conversationId: conv.id, direction: 'in_' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, text: true },
    });
    if (!latest) return { ok: true, skipped: 'no_inbound' };
    sourceMessage = { id: latest.id, text: latest.text };
  }

  const sourceMessageId = sourceMessage.id;

  // Extraction input is the single triggering message — the same message we
  // attribute points to (provenance unit). `replies` is a one-element array so
  // the extractor-agent input shape is unchanged.
  const replies = sourceMessage.text ? [sourceMessage.text] : [];
  if (replies.length === 0) {
    await stampExtractionStatus({ conversationId: conv.id, messageId: sourceMessageId, status: 'no_signal' });
    return { ok: true, skipped: 'empty_inbound' };
  }

  // Deterministic pre-gate: skip the two extractor LLM calls on
  // obviously empty service-talk turns ("ок", "напишу в 5"). The classifier
  // returns a structured `{pass, reason}` so we can track passed_by /
  // skipped_by counters in logs and tune the predicate from real data.
  // See `packages/shared/src/agency-detection.ts` for the policy.
  const gate = preGateExtraction(sourceMessage.text);
  if (!gate.pass) {
    logger.info(
      {
        event: 'profile_extract.pregate_skip',
        conversationId: conv.id,
        sourceMessageId,
        skipped_by: gate.reason,
      },
      'profile-extract pre-gate skipped: no extraction signal',
    );
    await stampExtractionStatus({ conversationId: conv.id, messageId: sourceMessageId, status: 'no_signal' });
    return { ok: true, skipped: 'no_signal', reason: gate.reason };
  }
  logger.info(
    {
      event: 'profile_extract.pregate_pass',
      conversationId: conv.id,
      sourceMessageId,
      passed_by: gate.reason,
    },
    'profile-extract pre-gate passed; invoking extractors',
  );

  const channelTitle = conv.contact.channel?.title ?? '';
  const language = conv.contact.channel?.language ?? 'ru';

  // Operator hints (operator-reanalyze-and-markup): advisory parsing rules the
  // operator added — global, for this channel, or for this conversation. Capped
  // and rendered into a fenced block by the agents.
  const hintRows = await prisma.extractionHint.findMany({
    where: {
      active: true,
      OR: [
        { scope: 'global' },
        { scope: 'channel', channelId },
        { scope: 'conversation', conversationId: conv.id },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: EXTRACTION_HINT_LIMIT,
  });
  const operatorHints = hintsToOperatorStrings(
    hintRows.map((h) => ({
      guidance: h.guidance,
      exampleInput: h.exampleInput,
      exampleOutput: h.exampleOutput,
      targetField: h.targetField,
    })),
  );

  const extractorInput = {
    replies,
    last_inbound: replies[replies.length - 1] ?? '',
    channel_title: channelTitle,
    language,
    operator_hints: operatorHints,
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

  // Distinguish "extractor call failed" (BullMQ should retry the whole job)
  // from "call returned empty data_points" (legitimate success — the inbound
  // just didn't carry that kind of fact). The previous behaviour swallowed
  // any failure as `{ ok:true }`; now ANY null from `runAgentSafe` throws so
  // the queue retries. A successful rate extractor whose audience companion
  // returned null is still a partial loss (audience facts are lost on this
  // tick) — better to redo both than to silently drop one. Sync callers
  // (`handleOnInbound`) catch and log without aborting the inbound pipeline.
  if (!rate || !audience) {
    const failed: string[] = [];
    if (!rate) failed.push('rate_card_extractor');
    if (!audience) failed.push('audience_stats_extractor');
    throw new Error(`profile-extract: extractors failed: ${failed.join(', ')}`);
  }

  const drafts: Array<{ extractedBy: string; draft: ProfileDataPointDraft }> = [];
  for (const dp of rate?.data_points ?? []) {
    drafts.push({ extractedBy: 'rate_card_extractor', draft: dp });
  }
  for (const dp of audience?.data_points ?? []) {
    drafts.push({ extractedBy: 'audience_stats_extractor', draft: dp });
  }

  // Structured placement offers are the CANONICAL write path
  // (harden-reply-extraction D3): always persist the extractor's
  // placement_offers as `placement.offer` ProfileDataPoint rows and its
  // attribute_proposals as `placement_attribute` rows (status='proposed'),
  // independent of any feature flag. The `structured_placement_offers` flag
  // now governs only downstream matching/planner preference — not persistence.
  //
  // NOTE: computed BEFORE the empty-short-circuit below. The extractor can
  // legitimately return ONLY structured offers (e.g. "пост 50000 + условия")
  // with no legacy `data_points` — short-circuiting on `drafts.length === 0`
  // alone would silently drop that extraction.
  const placementOfferDrafts: PlacementOfferDraft[] = rate?.placement_offers ?? [];
  const attributeProposals: PlacementAttributeProposalDraft[] = rate?.attribute_proposals ?? [];

  const nothingExtracted =
    drafts.length === 0 && placementOfferDrafts.length === 0 && attributeProposals.length === 0;
  // Normally a clean-but-empty extraction short-circuits. But on an operator
  // SUPERSEDE re-run we must still enter the transaction to DELETE the prior
  // (false-positive) rows and re-roll — otherwise reanalyze couldn't clear bad
  // data (codex). So only short-circuit when not superseding.
  if (nothingExtracted && !data.supersede) {
    await stampExtractionStatus({ conversationId: conv.id, messageId: sourceMessageId, status: 'empty' });
    return { ok: true, channelId, dataPoints: 0 };
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

    // Backfill media assets that were attached to inbound messages on THIS
    // conversation BEFORE the profile existed (e.g. a media-kit PDF arrived
    // as the very first message). At write time those rows have
    // `profileId = null` because the catalog profile didn't exist yet. As
    // soon as we create the profile, attach them by conversation scope.
    // Idempotent: re-runs match zero rows once everything is linked.
    // (See `media-asset-storage` + `blogger-commercial-profile` specs.)
    await tx.mediaAsset.updateMany({
      where: { conversationId: conv.id, profileId: null },
      data: { profileId: profile.id },
    });

    // Operator re-run supersede (operator-reanalyze-and-markup): after both
    // extractors succeeded, delete the PRIOR rows for this (profileId,
    // sourceMessageId) so the fresh extraction REPLACES them instead of being
    // skipped by the idempotency `findFirst` below. Runs only on an explicit
    // re-run; never touches operator-origin points (sourceMessageId is null on
    // those). Deleting here — after extraction, inside the write tx — means a
    // failed re-extraction never lost the old data (it threw before this tx).
    if (data.supersede) {
      await tx.profileDataPoint.deleteMany({
        where: { profileId: profile.id, sourceMessageId, extractedBy: { not: 'operator' } },
      });
      // Only proposed (unreviewed) attributes — an admin-approved `active` row
      // is a curated registry entry the planner uses; a message re-run must not
      // silently remove it (codex).
      await tx.placementAttribute.deleteMany({ where: { sourceMessageId, status: 'proposed' } });
      await tx.mediaAsset.deleteMany({
        where: { profileId: profile.id, messageId: sourceMessageId, kind: 'raw_payload' },
      });
    }

    for (const { extractedBy, draft } of drafts) {
      // Idempotency: the same (profileId, sourceMessageId, field, extractedBy)
      // tuple should produce at most one row. handleProfileExtract may be
      // re-run for the same source message (sync invocation from on_inbound
      // followed by an on-demand BullMQ enqueue) and we don't want
      // duplicates. Cheaper than adding a unique index migration.
      const existing = await tx.profileDataPoint.findFirst({
        where: { profileId: profile.id, sourceMessageId, field: draft.field, extractedBy },
        select: { id: true },
      });
      if (existing) continue;
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

    // Dual-write structured placement offers as `placement.offer` data points
    // (entity-style-rate-cards). Idempotent on
    // (profileId, sourceMessageId, field='placement.offer', extractedBy) PLUS
    // the offer's rawSnippet (so two distinct offers from the same message —
    // e.g. day vs month post — both persist, but a re-run does not duplicate).
    {
      const capturedAt = now.toISOString();
      for (const draft of placementOfferDrafts) {
        const offer = stampOfferProvenance(draft, {
          sourceMessageId,
          extractedBy: 'rate_card_extractor',
          capturedAt,
        });
        const value = PlacementOfferZ.parse(offer);
        const existing = await tx.profileDataPoint.findFirst({
          where: {
            profileId: profile.id,
            sourceMessageId,
            field: 'placement.offer',
            extractedBy: 'rate_card_extractor',
            rawSnippet: value.rawSnippet,
          },
          select: { id: true },
        });
        if (existing) continue;
        await tx.profileDataPoint.create({
          data: {
            profileId: profile.id,
            field: 'placement.offer',
            value: value as never,
            unit: value.currency,
            confidence: value.confidence,
            extractedBy: 'rate_card_extractor',
            sourceMessageId,
            rawSnippet: value.rawSnippet,
            capturedAt: now,
          },
        });
      }

      // Persist attribute proposals as `placement_attribute` rows
      // (status='proposed'). Dedupe by (key, sourceMessageId) so the same
      // suggestedKey from the same source message is not duplicated on re-run.
      for (const proposal of attributeProposals) {
        const key = proposal.suggestedKey.trim();
        if (!key) continue;
        const existing = await tx.placementAttribute.findFirst({
          where: { key, sourceMessageId },
          select: { id: true },
        });
        if (existing) continue;
        await tx.placementAttribute.create({
          data: {
            key,
            valueType: proposal.suggestedType,
            description: proposal.rationale,
            applicableKinds: proposal.applicableKinds,
            enumValues: proposal.enumValues ?? [],
            status: 'proposed',
            evidence: proposal.evidence as never,
            confidence: proposal.confidence,
            rationale: proposal.rationale,
            sourceMessageId,
            // The agent run id is not surfaced by `runAgentSafe` (it returns
            // only the parsed output). Correlate proposals to the run via the
            // (profileId, sourceMessageId) tuple + the `agent_run` row written
            // by AgentRunner for this conversation/message. Left null until the
            // runner exposes the id. (Section follow-up.)
            proposedByRunId: null,
          },
        });
      }
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
        // Structured placement offers are canonical: always persist the rolled-up
        // `placementOffers` (harden-reply-extraction D3), so the catalog is
        // structurally complete regardless of the matching/planner-preference flag.
        placementOffers: rolled.placementOffers as never,
        // Per-platform audience sizes (placement-representation-v2).
        platformAudience: rolled.platformAudience as never,
      },
    });

    return { profileId: profile.id, dataPointsCreated: drafts.length };
  });

  // Snapshot the verbatim raw payload (triggering inbound + parsed extractor
  // output) to object storage under a deterministic key and record a
  // `raw_payload` media_asset linked to the same profile/conversation the data
  // points reference (agency-sourcing-matching M6, task 6.3). Behind
  // ENABLE_OBJECT_STORAGE; degrades safely — never blocks extraction.
  //
  // S3 (provenance discoverability): there is no FK column from a
  // profile_data_point to its raw-payload media_asset. The linkage is the tuple
  // (profileId, sourceMessageId): every data point carries `profileId` +
  // `sourceMessageId`, and the raw-payload object key is
  // `rawPayloadKey({ conversationId, sourceMessageId })` — i.e. the snapshot
  // key embeds the same sourceMessageId. So given a data point, the raw payload
  // is the `kind='raw_payload'` media_asset on the same profileId whose s3Key
  // ends with `/{sourceMessageId}.json`. No migration added.
  if (getFeatureFlags().get('object_storage') && sourceMessageId) {
    const snapshotKey = await snapshotRawPayload({
      conversationId: conv.id,
      sourceMessageId,
      rawText: extractorInput.last_inbound,
      parsed: { rate, audience },
      // N1: namespace the snapshot under the profile we just rolled up.
      profileId: result.profileId,
    }).catch(() => null);
    if (snapshotKey) {
      await prisma.mediaAsset
        .create({
          data: {
            conversationId: conv.id,
            profileId: result.profileId,
            // messageId ties the raw-payload row to its source message so an
            // operator re-run supersede can find+delete the prior one
            // (operator-reanalyze-and-markup).
            messageId: sourceMessageId,
            kind: 'raw_payload',
            s3Key: snapshotKey,
            mime: 'application/json',
            sourceTgMsgId: null,
          },
        })
        .catch((err) => {
          logger.warn(
            { conversationId: conv.id, err: (err as Error).message },
            'raw payload media_asset row failed; snapshot still written',
          );
          return null;
        });
    }
  }

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

  // Data-collection HUD realtime patch (data-collection-hud-target-fields
  // change, Phase 1). One event per effective target the just-written
  // drafts touch. Flag-gated so flag-off behavior matches today exactly.
  // Fire-and-forget — failures here never mask extraction success.
  if (getFeatureFlags().get('data_collection_hud')) {
    await emitDataCollectionUpdatesForExtraction({
      conversationId: conv.id,
      profileId: result.profileId,
      campaign: conv.campaign,
      writtenFields: drafts.map((d) => d.draft.field),
    }).catch((err) =>
      logger.warn(
        { conversationId: conv.id, err: (err as Error).message },
        'data_collection.updated emit failed (non-fatal)',
      ),
    );
  }

  await stampExtractionStatus({
    conversationId: conv.id,
    messageId: sourceMessageId,
    // A superseding re-run that extracted nothing still cleared the old rows —
    // its outcome is `empty`, not `ok`.
    status: nothingExtracted ? 'empty' : 'ok',
  });
  return { ok: true, ...result };
}

/**
 * After a successful `ProfileDataPoint` write, emit one
 * `dataCollectionUpdated` event per effective target whose match keys the
 * write touched. Reads the conversation's full data-point set + the
 * latest `meta.targetField` per target from existing suggestions so the
 * payload reflects the post-write state — the web client patches in place
 * without re-fetching the HUD.
 */
async function emitDataCollectionUpdatesForExtraction(opts: {
  conversationId: string;
  profileId: string;
  campaign: { goal?: unknown; type?: { key?: string | null } | null } | null | undefined;
  writtenFields: string[];
}): Promise<void> {
  const targets = resolveEffectiveHudTargets(opts.campaign ?? null);
  if (targets.length === 0) return;

  // Affected targets = those whose match keys catch ANY of the just-written
  // fields. Dedup per target.key. Skip manual_only — extractor writes
  // never satisfy a manual target.
  const affected = new Map<string, DataCollectionTarget>();
  for (const field of opts.writtenFields) {
    for (const t of targetsForProfileField(field)) {
      if (t.manual_only) continue;
      // Only emit for targets the conversation's campaign actually surfaces.
      if (!targets.find((eff) => eff.key === t.key)) continue;
      affected.set(t.key, t);
    }
  }
  if (affected.size === 0) return;

  const prisma = getPrisma();
  // Load the full profile + suggestion target-field history once.
  const [profile, suggestions] = await Promise.all([
    prisma.bloggerProfile.findUnique({
      where: { id: opts.profileId },
      select: {
        dataPoints: {
          select: { field: true, value: true, capturedAt: true, sourceMessageId: true },
        },
      },
    }),
    prisma.suggestion.findMany({
      where: { conversationId: opts.conversationId },
      select: { meta: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const dataPoints = (profile?.dataPoints ?? []).map((dp) => ({
    field: dp.field,
    value: dp.value,
    capturedAt: dp.capturedAt,
    sourceMessageId: dp.sourceMessageId,
  }));
  const lastAskedByTarget = new Map<string, Date>();
  for (const sug of suggestions) {
    const tf = getSuggestionTargetField(sug);
    if (!tf) continue;
    if (lastAskedByTarget.has(tf)) continue;
    lastAskedByTarget.set(tf, sug.createdAt);
  }

  for (const target of affected.values()) {
    const row = buildHudTargetRow(
      target,
      dataPoints,
      lastAskedByTarget.get(target.key) ?? null,
    );
    await publishRealtime(`conversation:${opts.conversationId}`, {
      type: 'data_collection.updated',
      conversationId: opts.conversationId,
      targetKey: target.key,
      state: row.state,
      ...(row.current ? { current: row.current } : {}),
      ...(row.freshness ? { freshness: row.freshness } : {}),
      ...(row.lastAskedAt ? { lastAskedAt: row.lastAskedAt } : {}),
    });
  }
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
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, 'profile-extract failed');
    // Stamp `failed` only on TERMINAL exhaustion (operator-reanalyze-and-markup):
    // between automatic retries the message stays `pending`, so a transient
    // failure is not shown as a terminal one. Requires an explicit sourceMessageId
    // (the operator re-run path always carries it).
    const data = job?.data as { conversationId?: string; sourceMessageId?: string } | undefined;
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    if (data?.conversationId && data.sourceMessageId && attemptsMade >= maxAttempts) {
      void stampExtractionStatus({
        conversationId: data.conversationId,
        messageId: data.sourceMessageId,
        status: 'failed',
        error: err?.message ?? 'extraction failed',
      });
    }
  });
  return worker;
}
