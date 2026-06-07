import { Queue, Worker } from 'bullmq';
import { getPrisma, decryptJson } from '@nosquare/db';
import {
  GuidedDiscoveryJobZ,
  GuidedRunBudgetsZ,
  GuidedRunInputSnapshotZ,
  GuidedRunSummaryZ,
  DiscoveryTraceEventZ,
  PlannedQueryZ,
  QueueNames,
  type GuidedRunSummary,
  type GuidedRunInputSnapshot,
  type PlannedQuery,
  type DiscoveryTraceEvent,
  type DiscoveryTraceStage,
  type Platform,
} from '@nosquare/shared';
import { YandexSearchClient, executePlannedSearches } from '@nosquare/platforms';

import { getRedis } from '../redis.js';
import { logger } from '../logger.js';
import { getRunner } from '../services/runner.js';

interface YandexSearchConfig {
  apiKey: string;
  folderId: string;
  baseUrl?: string;
}

interface PlannerOutput {
  queries: Array<{
    query: string;
    platform: Platform | null;
    rationale?: string;
    signal?: string;
    negative_terms?: string[];
    confidence?: number;
  }>;
}

interface ReviewerOutput {
  score: number;
  recommendation: 'strong_fit' | 'possible_fit' | 'weak_fit' | 'reject';
  rationale: string;
  risk_notes: string[];
  evidence: Array<{
    post_id: string | null;
    date: string | null;
    snippet: string;
    urls: string[];
    why: string;
  }>;
  insufficient_evidence_reason: string | null;
}

interface RawPost {
  id?: string | number;
  date?: string;
  text?: string;
  urls?: string[];
}

/**
 * Guided blogger discovery worker (ajtbd-guided-blogger-discovery, section 4).
 *
 * Orchestrates the run: resolve the stable input snapshot → plan queries with
 * `discovery_query_planner` (budget-truncated) → execute traceable Yandex
 * searches via the shared search core → normalize/dedupe candidates, create or
 * reuse `Channel` rows and enqueue scrape for new ones → load public evidence
 * → score candidates with `blogger_discovery_reviewer` within the review
 * budget. Every stage writes a sanitized trace event onto the run; a fatal
 * throw marks the run `failed` with a visible trace rather than leaving it
 * stuck `running`.
 */
async function handleGuidedDiscovery(data: { runId: string }): Promise<void> {
  const prisma = getPrisma();
  const scrapeQueue = new Queue(QueueNames.channelScrape, { connection: getRedis() });

  const run = await prisma.discoveryRun.findUnique({ where: { id: data.runId } });
  if (!run) {
    logger.warn({ runId: data.runId }, 'guided-discovery: row missing, skipping');
    return;
  }
  if (run.status === 'done' || run.status === 'failed') {
    logger.info({ runId: data.runId, status: run.status }, 'guided-discovery: terminal, skipping');
    return;
  }

  // Atomic claim with staleness gate (mirrors discovery-batch). A `running`
  // row is only re-claimable after STALE_LOCK_MS — the live worker renews the
  // lock via @updatedAt on every persist() between stages.
  const STALE_LOCK_MS = 5 * 60 * 1000;
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  const claim = await prisma.discoveryRun.updateMany({
    where: {
      id: run.id,
      OR: [{ status: 'pending' }, { status: 'running', updatedAt: { lt: staleBefore } }],
    },
    data: { status: 'running' },
  });
  if (claim.count !== 1) {
    logger.info({ runId: data.runId }, 'guided-discovery: lost claim race');
    return;
  }

  // ─── stable run state ───
  const snapshot: GuidedRunInputSnapshot = GuidedRunInputSnapshotZ.parse(run.input); // task 4.2
  const budgets = snapshot.budgets;
  const summary: GuidedRunSummary =
    GuidedRunSummaryZ.safeParse(run.summary).success && (run.summary as { budgets?: unknown }).budgets
      ? GuidedRunSummaryZ.parse(run.summary)
      : GuidedRunSummaryZ.parse({ budgets });
  const trace: DiscoveryTraceEvent[] = Array.isArray(run.trace)
    ? (run.trace as unknown[])
        .map((e) => DiscoveryTraceEventZ.safeParse(e))
        .filter((r): r is { success: true; data: DiscoveryTraceEvent } => r.success)
        .map((r) => r.data)
    : [];

  const addTrace = (e: Partial<DiscoveryTraceEvent> & { stage: DiscoveryTraceStage }): void => {
    trace.push(DiscoveryTraceEventZ.parse({ ts: new Date().toISOString(), status: 'info', ...e }));
  };
  let plannedQueries: PlannedQuery[] = [];
  const persist = async (extra: Record<string, unknown> = {}): Promise<void> => {
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: { trace: trace as object, summary: summary as object, plannedQueries: plannedQueries as object, ...extra },
    });
  };

  try {
    // ── integration ──
    const integ = await prisma.integration.findUnique({ where: { kind: 'yandex_search' } });
    if (!integ || !integ.enabled) {
      summary.fatalError = 'yandex_search integration not configured/disabled';
      addTrace({ stage: 'error', status: 'error', error: summary.fatalError });
      await persist({ status: 'failed', completedAt: new Date() });
      return;
    }
    const cfg = await decryptJson<YandexSearchConfig>(integ.configEncrypted);
    if (!cfg?.apiKey || !cfg?.folderId) {
      summary.fatalError = 'yandex_search integration missing apiKey/folderId';
      addTrace({ stage: 'error', status: 'error', error: summary.fatalError });
      await persist({ status: 'failed', completedAt: new Date() });
      return;
    }
    const client = new YandexSearchClient({
      apiKey: cfg.apiKey,
      folderId: cfg.folderId,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    });

    // ── planner (task 4.3) ──
    addTrace({ stage: 'planner.started', message: 'planning search queries' });
    await persist();
    const runner = getRunner();
    let plan: PlannerOutput | null = null;
    try {
      plan = await runner.run<PlannerOutput>(
        'discovery_query_planner',
        {
          brief: snapshot.brief,
          ajtbd: snapshot.ajtbd,
          platform: snapshot.platform,
          geo: snapshot.geo,
          language: snapshot.language,
          max_queries: budgets.maxQueries,
        },
        snapshot.campaignId ? { campaignId: snapshot.campaignId } : {},
      );
    } catch (err) {
      addTrace({ stage: 'error', status: 'error', error: `planner failed: ${(err as Error).message}` });
    }

    const rawQueries = plan?.queries ?? [];
    if (rawQueries.length === 0) {
      summary.fatalError = 'planner returned no usable queries';
      addTrace({ stage: 'error', status: 'error', error: summary.fatalError });
      await persist({ status: 'failed', completedAt: new Date() });
      return;
    }

    plannedQueries = rawQueries.map((q) =>
      PlannedQueryZ.parse({
        query: q.query,
        platform: q.platform ?? null,
        rationale: q.rationale ?? '',
        signal: q.signal ?? '',
        negativeTerms: q.negative_terms ?? [],
        confidence: q.confidence ?? 0.5,
      }),
    );
    // Deterministic budget truncation (spec: bounded planner output).
    if (plannedQueries.length > budgets.maxQueries) {
      addTrace({
        stage: 'budget.truncated',
        message: `planner produced ${plannedQueries.length} queries; truncated to ${budgets.maxQueries}`,
        candidateCount: budgets.maxQueries,
      });
      plannedQueries = plannedQueries.slice(0, budgets.maxQueries);
    }
    summary.plannedQueries = plannedQueries.length;
    addTrace({ stage: 'planner.completed', message: `planned ${plannedQueries.length} queries`, candidateCount: plannedQueries.length });
    await persist();

    // ── search (task 4.4) ──
    addTrace({ stage: 'search.started', message: 'executing planned searches' });
    await persist();
    const { candidates, trace: searchTrace } = await executePlannedSearches(
      client,
      plannedQueries.map((q) => ({ query: q.query, platform: q.platform })),
      { limitPerQuery: budgets.maxResultsPerQuery, maxCandidates: budgets.maxCandidates },
    );
    for (const st of searchTrace) {
      addTrace({
        stage: 'search.completed',
        status: st.status,
        query: st.query,
        ...(st.platform ? { platform: st.platform } : {}),
        resultCount: st.resultCount,
        candidateCount: st.candidateCount,
        ...(st.error ? { error: st.error } : {}),
      });
    }
    summary.executedQueries = searchTrace.filter((t) => t.status === 'ok').length;
    summary.failedQueries = searchTrace.filter((t) => t.status === 'error').length;
    summary.candidatesFound = candidates.length;

    // Normalize → create/reuse Channel rows → persist candidate rows.
    interface WorkCand {
      candidateId: string;
      channelId: string | null;
      platform: Platform;
      handle: string;
      alreadyKnown: boolean;
    }
    const work: WorkCand[] = [];
    for (const c of candidates) {
      let channelId: string | null = null;
      let alreadyKnown = false;
      const existing = await prisma.channel.findUnique({
        where: { platform_handle: { platform: c.platform, handle: c.handle } },
        select: { id: true },
      });
      if (existing) {
        channelId = existing.id;
        alreadyKnown = true;
        summary.knownChannels += 1;
      } else {
        try {
          const ch = await prisma.channel.create({
            data: {
              platform: c.platform,
              handle: c.handle,
              status: 'new',
              source: `guided:${run.id}`,
              addedById: run.createdById,
              links: [],
            },
          });
          channelId = ch.id;
          summary.newChannels += 1;
          await scrapeQueue.add('scrape', { channelId });
          addTrace({ stage: 'scrape.queued', handle: c.handle });
        } catch {
          // Lost a findUnique→create race; treat as known.
          const retry = await prisma.channel.findUnique({
            where: { platform_handle: { platform: c.platform, handle: c.handle } },
            select: { id: true },
          });
          channelId = retry?.id ?? null;
          alreadyKnown = true;
          summary.knownChannels += 1;
        }
      }

      const candRow = await prisma.discoveryRunCandidate.upsert({
        where: { runId_platform_handle: { runId: run.id, platform: c.platform, handle: c.handle } },
        create: {
          runId: run.id,
          channelId,
          platform: c.platform,
          handle: c.handle,
          provenance: {
            sourceQueries: c.sourceQueries,
            url: c.url,
            title: c.title,
            alreadyKnown,
          } as object,
          enrichmentStatus: alreadyKnown ? 'enriched' : 'needs_scrape',
        },
        update: {
          channelId,
          provenance: {
            sourceQueries: c.sourceQueries,
            url: c.url,
            title: c.title,
            alreadyKnown,
          } as object,
        },
      });
      work.push({ candidateId: candRow.id, channelId, platform: c.platform, handle: c.handle, alreadyKnown });
      addTrace({ stage: 'candidate.normalized', handle: c.handle, candidateId: candRow.id });
    }
    await persist();

    // ── review (tasks 4.5 + 4.6) ──
    addTrace({ stage: 'review.started', message: 'scoring candidates' });
    await persist();
    // Priority: candidates with existing data (alreadyKnown) first — they can
    // be reviewed immediately; brand-new channels may still be scraping.
    work.sort((a, b) => Number(b.alreadyKnown) - Number(a.alreadyKnown));

    let reviewed = 0;
    let skipped = 0;
    let recommended = 0;
    for (const cand of work) {
      if (reviewed >= budgets.maxReviewed) {
        skipped += 1;
        continue;
      }
      // Load public channel metadata, recent public posts, profile (task 4.5).
      const ch = cand.channelId
        ? await prisma.channel.findUnique({ where: { id: cand.channelId } })
        : null;
      const posts: RawPost[] = ((ch?.rawData as { posts?: RawPost[] } | null)?.posts ?? []).slice(0, 10);
      const hasData = Boolean(
        ch && (ch.status === 'scraped' || posts.length > 0 || ch.title || ch.description),
      );

      if (!hasData) {
        // No public evidence yet — don't pretend it exists (spec). Leave the
        // candidate for a later refresh once scrape completes.
        await prisma.discoveryRunCandidate.update({
          where: { id: cand.candidateId },
          data: { enrichmentStatus: 'needs_scrape' },
        });
        addTrace({
          stage: 'candidate.normalized',
          status: 'info',
          handle: cand.handle,
          candidateId: cand.candidateId,
          message: 'awaiting scrape — no public evidence yet',
        });
        continue;
      }

      const profile = cand.channelId
        ? await prisma.bloggerProfile.findFirst({
            where: { channelId: cand.channelId },
            select: { topics: true, languages: true, formats: true },
          })
        : null;

      let review: ReviewerOutput | null = null;
      try {
        review = await runner.run<ReviewerOutput>(
          'blogger_discovery_reviewer',
          {
            brief: snapshot.brief,
            ajtbd: snapshot.ajtbd,
            candidate: {
              platform: cand.platform,
              handle: cand.handle,
              title: ch?.title ?? '',
              description: ch?.description ?? '',
              followers: ch?.followers ?? null,
              language: ch?.language ?? null,
              profile: profile ?? null,
              recent_posts: posts.map((p, i) => ({
                id: p.id != null ? String(p.id) : String(i + 1),
                date: p.date ?? null,
                text: p.text ?? '',
                urls: Array.isArray(p.urls) ? p.urls : [],
              })),
            },
          },
          {
            ...(snapshot.campaignId ? { campaignId: snapshot.campaignId } : {}),
            ...(cand.channelId ? { channelId: cand.channelId } : {}),
          },
        );
      } catch (err) {
        addTrace({
          stage: 'error',
          status: 'error',
          handle: cand.handle,
          candidateId: cand.candidateId,
          error: `reviewer failed: ${(err as Error).message}`,
        });
        continue;
      }

      reviewed += 1;
      const isRecommended = review.recommendation === 'strong_fit' || review.recommendation === 'possible_fit';
      if (isRecommended) recommended += 1;
      await prisma.discoveryRunCandidate.update({
        where: { id: cand.candidateId },
        data: {
          enrichmentStatus: posts.length > 0 ? 'enriched' : 'pending_enrichment',
          score: review.score,
          recommendation: review.recommendation,
          review: {
            rationale: review.rationale,
            riskNotes: review.risk_notes ?? [],
            evidence: (review.evidence ?? []).map((e) => ({
              postId: e.post_id,
              date: e.date,
              snippet: e.snippet,
              urls: e.urls ?? [],
              why: e.why ?? '',
            })),
            insufficientEvidenceReason: review.insufficient_evidence_reason,
          } as object,
        },
      });
      addTrace({ stage: 'review.completed', handle: cand.handle, candidateId: cand.candidateId, message: review.recommendation });
      if (isRecommended) {
        addTrace({ stage: 'candidate.recommended', handle: cand.handle, candidateId: cand.candidateId, message: review.recommendation });
      }
    }

    if (skipped > 0) {
      addTrace({
        stage: 'budget.truncated',
        message: `${skipped} candidate(s) skipped (review budget ${budgets.maxReviewed})`,
        candidateCount: skipped,
      });
    }
    summary.candidatesReviewed = reviewed;
    summary.candidatesSkipped = skipped;
    summary.recommended = recommended;

    addTrace({ stage: 'review.completed', message: `reviewed ${reviewed}, skipped ${skipped}` });
    await persist({ status: 'done', completedAt: new Date() });
    logger.info({ runId: run.id, reviewed, recommended, skipped }, 'guided-discovery: done');
  } catch (err) {
    summary.fatalError = `worker error: ${(err as Error).message}`;
    addTrace({ stage: 'error', status: 'error', error: summary.fatalError });
    logger.error({ runId: run.id, err: (err as Error).message }, 'guided-discovery: unexpected error, marking failed');
    await prisma.discoveryRun
      .update({
        where: { id: run.id },
        data: { status: 'failed', completedAt: new Date(), trace: trace as object, summary: summary as object },
      })
      .catch(() => undefined);
  }
}

export function startGuidedDiscoveryWorker() {
  return new Worker(
    QueueNames.guidedDiscovery,
    async (job) => {
      const data = GuidedDiscoveryJobZ.parse(job.data);
      await handleGuidedDiscovery(data);
    },
    {
      connection: getRedis(),
      // LLM planning + Yandex search are rate-limited; keep it sequential.
      concurrency: 1,
    },
  );
}

// Exported for unit tests.
export const __internal = { handleGuidedDiscovery };
