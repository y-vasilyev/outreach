import { Worker } from 'bullmq';
import { getPrisma, Prisma } from '@nosquare/db';
import {
  GuidedDiscoveryReviewJobZ,
  QueueNames,
  type GuidedDiscoveryReviewJob,
  type GuidedRunInputSnapshot,
  type GuidedRunSummary,
  type DiscoveryTraceEvent,
} from '@nosquare/shared';

import { getRedis } from '../redis.js';
import { logger } from '../logger.js';
import { getRunner } from '../services/runner.js';
import {
  makeAddTrace,
  parseSnapshot,
  parseSummary,
  parseTrace,
} from './guided-discovery-shared.js';

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

/** A candidate is "pending" (counts toward pendingReview) when it still has no
 *  review AND is not budget-skipped. Budget-skips carry `{ skipped: 'budget' }`
 *  so they don't pin the run open. */
function isBudgetSkip(review: unknown): boolean {
  return Boolean(review && typeof review === 'object' && (review as { skipped?: unknown }).skipped === 'budget');
}

function isReviewed(review: unknown): boolean {
  return review != null;
}

/** Count candidates that already consumed the reviewer budget (real reviews,
 *  not budget-skips, not insufficient-evidence no-LLM outcomes). Mirrors the
 *  phase-1 accounting so concurrent hook jobs can't collectively overspend. */
function countReviewedAgainstBudget(
  rows: Array<{ review: unknown }>,
): number {
  return rows.filter(
    (r) =>
      isReviewed(r.review) &&
      !isBudgetSkip(r.review) &&
      !(r.review as { noLlm?: unknown } | null)?.noLlm,
  ).length;
}

/**
 * Per-candidate review step of the guided-discovery evidence loop
 * (fix-guided-discovery-evidence-loop, D4/D5). Triggered by the channel-scrape
 * success/failure hook, the `scrape_refresh` re-arm, or a bounded sweep.
 *
 * Closes BUG #1/#2: the reviewer only runs once public evidence exists (or a
 * scrape definitively failed), recovers candidates that were left pending by
 * phase 1, and flips the run `enriching → done` exactly once when the loop
 * closes. An atomic candidate claim guards against duplicate jobs both spending
 * reviewer tokens.
 */
async function handleReview(data: GuidedDiscoveryReviewJob): Promise<void> {
  const prisma = getPrisma();

  const run = await prisma.discoveryRun.findUnique({ where: { id: data.runId } });
  if (!run) {
    logger.warn({ runId: data.runId }, 'guided-discovery-review: run missing, skipping');
    return;
  }
  if (run.status === 'done' || run.status === 'failed') {
    // Terminal run — nothing to review. (A sweep racing the last review is
    // resolved by the idempotent completion guard below.)
    return;
  }

  const snapshot: GuidedRunInputSnapshot = parseSnapshot(run.input);
  const summary: GuidedRunSummary = parseSummary(run.summary, snapshot.budgets);
  const trace: DiscoveryTraceEvent[] = parseTrace(run.trace);
  const addTrace = makeAddTrace(trace);

  const persistRun = async (extra: Record<string, unknown> = {}): Promise<void> => {
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: { trace: trace as object, summary: summary as object, ...extra },
    });
  };

  // ── Sweep branch (D5): force terminal outcomes on every still-open
  // candidate so a never-arriving scrape can't wedge the run. ──
  if (data.sweep) {
    const open = await prisma.discoveryRunCandidate.findMany({
      where: {
        runId: run.id,
        // AnyNull matches both fresh (SQL NULL) and re-cleared (JSON null) rows.
        OR: [{ review: { equals: Prisma.AnyNull } }, { enrichmentStatus: 'pending_enrichment' }],
      },
      select: { id: true, handle: true, review: true },
    });
    for (const c of open) {
      if (isReviewed(c.review) && !isBudgetSkip(c.review)) continue;
      await prisma.discoveryRunCandidate.update({
        where: { id: c.id },
        data: {
          enrichmentStatus: 'needs_scrape',
          reviewClaimedAt: new Date(),
          review: {
            rationale: '',
            riskNotes: [],
            evidence: [],
            insufficientEvidenceReason: 'scrape did not complete in time',
            noLlm: true,
          } as object,
        },
      });
      addTrace({
        stage: 'review.completed',
        status: 'info',
        handle: c.handle,
        candidateId: c.id,
        message: 'scrape did not complete in time',
      });
    }
    await persistRun();
    await closeRunIfComplete(run.id, summary, persistRun, addTrace);
    return;
  }

  if (!data.candidateId) {
    logger.warn({ runId: data.runId }, 'guided-discovery-review: non-sweep job without candidateId');
    return;
  }
  const candidateId = data.candidateId;

  // ── Step 0: atomic claim BEFORE any LLM work. The loser exits with zero
  // tokens spent. `scrape_refresh` resets `reviewClaimedAt=null` to re-arm. ──
  const claim = await prisma.discoveryRunCandidate.updateMany({
    where: { id: candidateId, reviewClaimedAt: null },
    data: { reviewClaimedAt: new Date() },
  });
  if (claim.count === 0) {
    // Already claimed by another job (or not re-armed) → no-op, no LLM call.
    return;
  }

  const candidate = await prisma.discoveryRunCandidate.findUnique({
    where: { id: candidateId },
  });
  if (!candidate || candidate.runId !== run.id) return;

  // ── Step 1: idempotency. If already reviewed and NOT re-armed for refresh,
  // no-op. On a refresh re-review, clear stale review/score/recommendation so a
  // prior result cannot leak through if the new review fails to write. ──
  const reArmed = candidate.enrichmentStatus === 'pending_enrichment';
  if (isReviewed(candidate.review) && !reArmed) {
    return;
  }
  if (isReviewed(candidate.review) && reArmed) {
    await prisma.discoveryRunCandidate.update({
      where: { id: candidate.id },
      data: { review: Prisma.JsonNull, score: null, recommendation: null },
    });
  }

  // ── Step 2: renew the run lock so the phase-1 staleness gate doesn't reclaim
  // a live run mid-review. ──
  await prisma.discoveryRun.update({ where: { id: run.id }, data: { updatedAt: new Date() } });

  // ── Step 3: budget check (recompute from persisted state). ──
  const allRows = await prisma.discoveryRunCandidate.findMany({
    where: { runId: run.id },
    select: { id: true, review: true },
  });
  const reviewedCount = countReviewedAgainstBudget(allRows.filter((r) => r.id !== candidate.id));
  if (reviewedCount >= snapshot.budgets.maxReviewed) {
    await prisma.discoveryRunCandidate.update({
      where: { id: candidate.id },
      data: { review: { skipped: 'budget' } as object },
    });
    addTrace({
      stage: 'budget.truncated',
      handle: candidate.handle,
      candidateId: candidate.id,
      message: `review budget ${snapshot.budgets.maxReviewed} reached`,
    });
    summary.candidatesSkipped += 1;
    await persistRun();
    await closeRunIfComplete(run.id, summary, persistRun, addTrace);
    return;
  }

  // ── Load evidence. ──
  const ch = candidate.channelId
    ? await prisma.channel.findUnique({ where: { id: candidate.channelId } })
    : null;
  const posts: RawPost[] = ((ch?.rawData as { posts?: RawPost[] } | null)?.posts ?? []).slice(0, 10);
  const hasData = Boolean(
    ch && (ch.status === 'scraped' || posts.length > 0 || ch.title || ch.description),
  );

  // ── Step 4: scrape failed OR no evidence → terminal insufficient-evidence
  // review WITHOUT an LLM call. ──
  if (data.scrapeOutcome === 'failed' || !hasData) {
    const reason =
      data.scrapeOutcome === 'failed'
        ? 'scrape failed — no public evidence available'
        : 'no public evidence yet (channel not scraped)';
    await prisma.discoveryRunCandidate.update({
      where: { id: candidate.id },
      data: {
        enrichmentStatus: 'needs_scrape',
        review: {
          rationale: '',
          riskNotes: [],
          evidence: [],
          insufficientEvidenceReason: reason,
          noLlm: true,
        } as object,
      },
    });
    addTrace({
      stage: 'review.completed',
      status: 'info',
      handle: candidate.handle,
      candidateId: candidate.id,
      message: reason,
    });
    await persistRun();
    await closeRunIfComplete(run.id, summary, persistRun, addTrace);
    return;
  }

  // ── Step 5: evidence present → call the reviewer agent (agent_run-accounted). ──
  const profile = candidate.channelId
    ? await prisma.bloggerProfile.findFirst({
        where: { channelId: candidate.channelId },
        select: { topics: true, languages: true, formats: true },
      })
    : null;

  let review: ReviewerOutput | null = null;
  try {
    review = await getRunner().run<ReviewerOutput>(
      'blogger_discovery_reviewer',
      {
        brief: snapshot.brief,
        ajtbd: snapshot.ajtbd,
        candidate: {
          platform: candidate.platform,
          handle: candidate.handle,
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
        ...(candidate.channelId ? { channelId: candidate.channelId } : {}),
      },
    );
  } catch (err) {
    // Reviewer failed — release the claim so a later retry/refresh can re-try,
    // and leave the candidate pending. The sweep is the bounded backstop.
    await prisma.discoveryRunCandidate.update({
      where: { id: candidate.id },
      data: { reviewClaimedAt: null },
    });
    addTrace({
      stage: 'error',
      status: 'error',
      handle: candidate.handle,
      candidateId: candidate.id,
      error: `reviewer failed: ${(err as Error).message}`,
    });
    await persistRun();
    return;
  }

  const isRecommended =
    review.recommendation === 'strong_fit' || review.recommendation === 'possible_fit';
  await prisma.discoveryRunCandidate.update({
    where: { id: candidate.id },
    data: {
      enrichmentStatus: 'enriched',
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
  summary.candidatesReviewed += 1;
  if (isRecommended) summary.recommended += 1;
  addTrace({
    stage: 'review.completed',
    handle: candidate.handle,
    candidateId: candidate.id,
    message: review.recommendation,
  });
  if (isRecommended) {
    addTrace({
      stage: 'candidate.recommended',
      handle: candidate.handle,
      candidateId: candidate.id,
      message: review.recommendation,
    });
  }
  await persistRun();
  await closeRunIfComplete(run.id, summary, persistRun, addTrace);
}

/**
 * Completion check (D4 step 6 / D5): recompute `pendingReview` from persisted
 * candidate rows. When it hits 0, flip `enriching → done` via a guarded
 * `updateMany` (count-1 wins; a racing sweep/last-review both resolve to one
 * `done`). Always persists the refreshed `summary.pendingReview`.
 */
async function closeRunIfComplete(
  runId: string,
  summary: GuidedRunSummary,
  persistRun: (extra?: Record<string, unknown>) => Promise<void>,
  addTrace: ReturnType<typeof makeAddTrace>,
): Promise<void> {
  const prisma = getPrisma();
  const rows = await prisma.discoveryRunCandidate.findMany({
    where: { runId },
    select: { review: true, enrichmentStatus: true },
  });
  // A candidate is pending when it has no review OR it has been re-armed by
  // `scrape_refresh` (enrichmentStatus='pending_enrichment') — the latter still
  // carries a STALE `review` until its re-review job runs, so counting only the
  // `review` column would prematurely close the run and strand the re-review at
  // the terminal-run guard (BUG #4).
  const pendingReview = rows.filter(
    (r) => !isReviewed(r.review) || r.enrichmentStatus === 'pending_enrichment',
  ).length;
  summary.pendingReview = pendingReview;

  if (pendingReview === 0) {
    const done = await prisma.discoveryRun.updateMany({
      where: { id: runId, status: 'enriching' },
      data: { status: 'done', completedAt: new Date() },
    });
    if (done.count === 1) {
      addTrace({ stage: 'review.completed', message: 'evidence loop closed — run done' });
    }
  }
  await persistRun();
}

export function startGuidedDiscoveryReviewWorker() {
  const worker = new Worker(
    QueueNames.guidedDiscoveryReview,
    async (job) => {
      const data = GuidedDiscoveryReviewJobZ.parse(job.data);
      await handleReview(data);
    },
    {
      connection: getRedis(),
      // Serial per process: bounds reviewer-budget overshoot and keeps the
      // completion check race-free alongside the atomic claim.
      concurrency: 1,
    },
  );
  worker.on('failed', (job, err) =>
    logger.error(
      {
        jobId: job?.id,
        runId: (job?.data as { runId?: string } | undefined)?.runId,
        err: err?.message,
      },
      'guided-discovery-review failed',
    ),
  );
  return worker;
}

// Exported for unit tests.
export const __internal = { handleReview, closeRunIfComplete, countReviewedAgainstBudget };
