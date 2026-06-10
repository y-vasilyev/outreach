import { Queue, Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import {
  buildHudTargetRow,
  EXTRACTION_HINT_LIMIT,
  getSuggestionTargetField,
  hintsToOperatorStrings,
  normalizeOffer,
  offerToRowFields,
  PlacementOfferZ,
  resolveViewsBasis,
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
import {
  composeOffersForRollup,
  getPrisma,
  persistPlacementOfferRow,
  Prisma,
  supersedeOfferRowsForMessage,
} from '@nosquare/db';
import { getFeatureFlags } from '../feature-flags.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';
import { runAgentSafeWithMeta } from '../services/run-agent-safe.js';
import { snapshotRawPayload } from '../services/media-store.js';
import { ocrMessageAttachments } from '../services/attachment-ocr.js';

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
    | { id: string; text: string; createdAt?: Date | null }
    | null = null;
  if (data.sourceMessageId) {
    const m = await prisma.message.findUnique({
      where: { id: data.sourceMessageId },
      select: { id: true, text: true, conversationId: true, direction: true, createdAt: true },
    });
    // Guard: the id must be an inbound message of THIS conversation.
    if (m && m.conversationId === conv.id && m.direction === 'in_') {
      sourceMessage = { id: m.id, text: m.text, createdAt: m.createdAt };
    }
  }
  if (!sourceMessage) {
    const latest = await prisma.message.findFirst({
      where: { conversationId: conv.id, direction: 'in_' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, text: true, createdAt: true },
    });
    if (!latest) return { ok: true, skipped: 'no_inbound' };
    sourceMessage = { id: latest.id, text: latest.text, createdAt: latest.createdAt };
  }

  const sourceMessageId = sourceMessage.id;

  // Extraction input is the single triggering message — the same message we
  // attribute points to (provenance unit). `replies` is a one-element array so
  // the extractor-agent input shape is unchanged.
  // Attachment OCR (attachment-ocr-ingestion): recognize text from image
  // attachments and fold it into the extractor input BEFORE the empty/pre-gate
  // checks, so an attachment-only reply (empty text) is not skipped. Double-
  // gated + degrades safely (returns [] when off/failed).
  const ocrTexts = await ocrMessageAttachments({
    conversationId: conv.id,
    messageId: sourceMessageId,
  }).catch(() => [] as string[]);

  const replies: string[] = [];
  if (sourceMessage.text) replies.push(sourceMessage.text);
  for (const t of ocrTexts) replies.push(`[из вложения] ${t}`);
  if (replies.length === 0) {
    await stampExtractionStatus({ conversationId: conv.id, messageId: sourceMessageId, status: 'no_signal' });
    return { ok: true, skipped: 'empty_inbound' };
  }

  // Deterministic pre-gate: skip the two extractor LLM calls on
  // obviously empty service-talk turns ("ок", "напишу в 5"). The classifier
  // returns a structured `{pass, reason}` so we can track passed_by /
  // skipped_by counters in logs and tune the predicate from real data.
  // See `packages/shared/src/agency-detection.ts` for the policy.
  // Pre-gate on the COMBINED text (chat text ∪ OCR'd attachment text), so an
  // attachment that carries commercial signal passes even when the chat text is
  // empty/service-talk (attachment-ocr-ingestion).
  const gate = preGateExtraction(replies.join('\n'));
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

  const [rateMeta, audienceMeta] = await Promise.all([
    runAgentSafeWithMeta<ExtractionOut>('rate_card_extractor', extractorInput, {
      conversationId: conv.id,
      channelId,
    }),
    runAgentSafeWithMeta<ExtractionOut>('audience_stats_extractor', extractorInput, {
      conversationId: conv.id,
      channelId,
    }),
  ]);
  const rate = rateMeta?.output ?? null;
  const audience = audienceMeta?.output ?? null;
  // Persisted agent_run ids (extraction-provenance): stamped onto every fact
  // each extractor emitted; null = run persistence failed (never dangling).
  const rateRunId = rateMeta?.runId ?? null;
  const audienceRunId = audienceMeta?.runId ?? null;

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

  const drafts: Array<{
    extractedBy: string;
    agentRunId: string | null;
    draft: ProfileDataPointDraft;
  }> = [];
  for (const dp of rate?.data_points ?? []) {
    drafts.push({ extractedBy: 'rate_card_extractor', agentRunId: rateRunId, draft: dp });
  }
  for (const dp of audience?.data_points ?? []) {
    drafts.push({ extractedBy: 'audience_stats_extractor', agentRunId: audienceRunId, draft: dp });
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

  // Inputs for write-time offer normalization (price-normalization-v2): the
  // current exchange rates + the channel profile's post insights / avgViews
  // for the CPM denominator. One fetch per job, outside the write tx (read-
  // only reference data; a stale-by-milliseconds rate is harmless and the
  // renormalize job reconciles on rate change).
  const offerCurrencies = [
    ...new Set(
      placementOfferDrafts
        .map((d) => (d.currency ?? 'RUB').trim().toUpperCase())
        .filter((c) => c !== 'RUB'),
    ),
  ];
  const [rateRows, profileForViews] = await Promise.all([
    offerCurrencies.length
      ? prisma.exchangeRate.findMany({ where: { currency: { in: offerCurrencies } } })
      : Promise.resolve([]),
    placementOfferDrafts.length
      ? prisma.bloggerProfile.findUnique({
          where: { channelId },
          select: {
            avgViews: true,
            postInsights: {
              select: { platform: true, metrics: true, publishedAt: true, metricCapturedAt: true },
              orderBy: [{ publishedAt: 'desc' }],
              take: 100,
            },
          },
        })
      : Promise.resolve(null),
  ]);
  const ratesByCurrency = new Map(rateRows.map((r) => [r.currency.toUpperCase(), r]));

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
      // Soft supersede (extraction-provenance): the prior generation is the
      // system's record of «что мы считали верным до переразбора» — exactly
      // when an operator decided the extraction was wrong. Mark, never delete.
      await tx.profileDataPoint.updateMany({
        where: {
          profileId: profile.id,
          sourceMessageId,
          extractedBy: { not: 'operator' },
          supersededAt: null,
        },
        data: { supersededAt: now },
      });
      // Only proposed (unreviewed) attributes — an admin-approved `active` row
      // is a curated registry entry the planner uses; a message re-run must not
      // silently remove it (codex). `superseded` ≠ `rejected`: переразбор
      // заменил, а не оператор отклонил.
      await tx.placementAttribute.updateMany({
        where: { sourceMessageId, status: 'proposed' },
        data: { status: 'superseded' },
      });
      await tx.mediaAsset.deleteMany({
        where: { profileId: profile.id, messageId: sourceMessageId, kind: 'raw_payload' },
      });
      // Offer ROWS are append-only (placement-offer-table): the prior
      // generation is marked superseded, never deleted — the audit trail of
      // «что мы считали верным до переразбора» survives the re-run.
      await supersedeOfferRowsForMessage(tx, { profileId: profile.id, sourceMessageId });
    }

    for (const { extractedBy, agentRunId, draft } of drafts) {
      // Idempotency: the same (profileId, sourceMessageId, field, extractedBy)
      // tuple should produce at most one row. handleProfileExtract may be
      // re-run for the same source message (sync invocation from on_inbound
      // followed by an on-demand BullMQ enqueue) and we don't want
      // duplicates. Cheaper than adding a unique index migration.
      const existing = await tx.profileDataPoint.findFirst({
        // Live rows only: a re-run just superseded the old generation — the
        // fresh writes must not be skipped as its duplicates.
        where: {
          profileId: profile.id,
          sourceMessageId,
          field: draft.field,
          extractedBy,
          supersededAt: null,
        },
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
          agentRunId,
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
      // Offer provenance `capturedAt` = the SOURCE MESSAGE timestamp, not the
      // extraction time («когда блогер это сказал»): a delayed retry or an
      // operator re-run of an OLD message must not look fresher than a newer
      // quote — supersede-by-identity recency compares this value (codex
      // review). The data-point row keeps `capturedAt = now` (when we learned
      // it) for HUD freshness.
      const capturedAt = (sourceMessage.createdAt ?? now).toISOString();
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
            supersededAt: null,
          },
          select: { id: true },
        });
        // The offer ROW is keyed to its originating data point: reuse the
        // existing row id on idempotent re-delivery, otherwise create both.
        // `persistPlacementOfferRow` is itself idempotent on
        // (profileId, sourceDataPointId), so either way re-runs are no-ops.
        let dataPointId: string;
        if (existing) {
          dataPointId = existing.id;
        } else {
          const createdDp = await tx.profileDataPoint.create({
            data: {
              profileId: profile.id,
              field: 'placement.offer',
              value: value as never,
              unit: value.currency,
              confidence: value.confidence,
              extractedBy: 'rate_card_extractor',
              sourceMessageId,
              agentRunId: rateRunId,
              rawSnippet: value.rawSnippet,
              capturedAt: now,
            },
            select: { id: true },
          });
          dataPointId = createdDp.id;
        }
        // Dual-write the first-class offer row (placement-offer-table) in the
        // SAME transaction: a failed row write fails the whole job (BullMQ
        // retries) — never partial state. Normalization (price-normalization-
        // v2) is computed write-time from the current rate + views basis.
        const rowFields = offerToRowFields(value);
        await persistPlacementOfferRow(tx, {
          profileId: profile.id,
          offer: value,
          sourceDataPointId: dataPointId,
          normalized: normalizeOffer(
            rowFields,
            ratesByCurrency.get(rowFields.currency.toUpperCase()) ?? null,
            resolveViewsBasis(
              profileForViews?.postInsights ?? [],
              rowFields.platform,
              profileForViews?.avgViews ?? null,
            ),
          ),
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
            // The persisted agent_run.id of the extractor run that proposed
            // this attribute (extraction-provenance).
            proposedByRunId: rateRunId,
          },
        });
      }
    }

    const allPoints = await tx.profileDataPoint.findMany({
      // Default readers see LIVE rows only (extraction-provenance).
      where: { profileId: profile.id, supersededAt: null },
    });
    const rollupInput: RollupDataPoint[] = allPoints.map((p) => ({
      field: p.field,
      value: p.value,
      unit: p.unit,
      confidence: Number(p.confidence),
      capturedAt: p.capturedAt,
    }));
    // placementOffers compose from the first-class offer ROWS when they fully
    // cover the profile's placement.offer data points (placement-offer-table
    // D6) — only `active` rows, so superseded prices drop out of the catalog
    // view. No rows yet / partial coverage → legacy compose-from-data-points
    // (never silently dropping uncovered offers); `rollup_source` makes the
    // fallback visible to ops.
    const offerPointIds = allPoints
      .filter((p) => p.field === 'placement.offer')
      .map((p) => p.id);
    const composed = await composeOffersForRollup(tx, profile.id, offerPointIds, (rowId) =>
      logger.warn(
        { profileId: profile.id, offerRowId: rowId },
        'placement_offer row unreadable; skipped from roll-up',
      ),
    );
    const rolled = rollUpProfileFields(
      rollupInput,
      composed.offers ? { placementOffers: composed.offers } : undefined,
    );
    logger.debug(
      { profileId: profile.id, rollup_source: composed.source },
      'placement offers composed',
    );

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

  // CPM consistency (codex review): write-time normalization saw the views
  // basis from BEFORE this extraction's roll-up. When this very message
  // carried offers and/or fresh views, recompute the profile's CPM against
  // the just-rolled values. Fire-and-forget — never fails extraction.
  const wroteViews = drafts.some(
    (d) => d.draft.field === 'views.avg' || d.draft.field === 'avg_views' || d.draft.field.startsWith('views.'),
  );
  if (placementOfferDrafts.length > 0 || wroteViews) {
    try {
      const renormalizeQueue = new Queue(QueueNames.offerRenormalize, { connection: getRedis() });
      await renormalizeQueue.add('renormalize', { profileId: result.profileId });
    } catch (err) {
      logger.warn(
        { profileId: result.profileId, err: (err as Error).message },
        'offer-renormalize enqueue failed after extraction',
      );
    }
  }

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
          where: { supersededAt: null },
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
