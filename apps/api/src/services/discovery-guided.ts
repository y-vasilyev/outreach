import { getPrisma } from '@nosquare/db';
import { Errors, extractAjtbdView } from '@nosquare/shared';
import {
  GuidedRunBudgetsZ,
  GuidedRunInputSnapshotZ,
  GuidedRunSummaryZ,
  GuidedRunDetailZ,
  GuidedRunListItemZ,
  PlannedQueryZ,
  DiscoveryTraceEventZ,
  EvidencePostZ,
  CandidateRecommendationZ,
  CandidateEnrichmentStatusZ,
  CandidateDecisionZ,
} from '@nosquare/shared';
import type {
  GuidedRunCreateInput,
  GuidedRunInputSnapshot,
  GuidedRunSummary,
  GuidedRunDetail,
  GuidedRunListItem,
  GuidedRunCandidate,
  CandidateAction,
  Platform,
} from '@nosquare/shared';

import { getQueues } from '../queues.js';

/**
 * Guided blogger discovery (ajtbd-guided-blogger-discovery change).
 *
 * Resolves the campaign goal/AJTBD or manual brief into a stable input
 * snapshot at create time (so the run stays auditable even if the campaign
 * later changes), persists a `DiscoveryRun`, and enqueues the async
 * `guided-discovery` worker. The status/detail endpoints just read the row;
 * candidate actions persist operator decisions and can request scrape
 * refresh without mutating unrelated candidates.
 */

function zeroSummary(budgets: GuidedRunSummary['budgets']): GuidedRunSummary {
  return GuidedRunSummaryZ.parse({ budgets });
}

/** Build the stable input snapshot. Loads the campaign when supplied. */
async function resolveInputSnapshot(
  input: GuidedRunCreateInput,
): Promise<GuidedRunInputSnapshot> {
  const prisma = getPrisma();
  const budgets = GuidedRunBudgetsZ.parse({ ...(input.budgets ?? {}) });

  if (input.campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: input.campaignId },
      include: { type: { select: { key: true } } },
    });
    if (!campaign) throw Errors.notFound('campaign', input.campaignId);
    const ajtbd = extractAjtbdView({
      goal: campaign.goal,
      goalText: campaign.goalText,
      valueProp: campaign.valueProp,
      typeKey: campaign.type?.key ?? null,
    });
    return GuidedRunInputSnapshotZ.parse({
      campaignId: campaign.id,
      brief: input.brief?.trim() || campaign.goalText,
      ajtbd,
      platform: input.platform ?? null,
      geo: input.geo,
      language: input.language ?? null,
      budgets,
    });
  }

  return GuidedRunInputSnapshotZ.parse({
    campaignId: null,
    brief: (input.brief ?? '').trim(),
    ajtbd: null,
    platform: input.platform ?? null,
    geo: input.geo,
    language: input.language ?? null,
    budgets,
  });
}

function briefPreview(brief: string): string {
  const s = brief.trim().replace(/\s+/g, ' ');
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

interface RunRow {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  createdAt: Date;
  completedAt: Date | null;
  campaignId: string | null;
  input: unknown;
  plannedQueries: unknown;
  trace: unknown;
  summary: unknown;
}

function parseSnapshot(raw: unknown): GuidedRunInputSnapshot {
  const parsed = GuidedRunInputSnapshotZ.safeParse(raw);
  return parsed.success
    ? parsed.data
    : GuidedRunInputSnapshotZ.parse({ budgets: GuidedRunBudgetsZ.parse({}) });
}

function parseSummary(raw: unknown, budgets: GuidedRunSummary['budgets']): GuidedRunSummary {
  const parsed = GuidedRunSummaryZ.safeParse(raw);
  return parsed.success ? parsed.data : zeroSummary(budgets);
}

interface CandidateRow {
  id: string;
  channelId: string | null;
  platform: string;
  handle: string;
  provenance: unknown;
  enrichmentStatus: string;
  review: unknown;
  score: { toNumber(): number } | number | null;
  recommendation: string | null;
  decision: string | null;
}

function toScore(s: CandidateRow['score']): number | null {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  return s.toNumber();
}

function toCandidate(
  row: CandidateRow,
  followers: number | null,
  bloggerProfileId: string | null,
): GuidedRunCandidate {
  const prov = (row.provenance ?? {}) as {
    sourceQueries?: unknown;
    url?: unknown;
    title?: unknown;
    alreadyKnown?: unknown;
  };
  const review = (row.review ?? null) as {
    rationale?: unknown;
    riskNotes?: unknown;
    evidence?: unknown;
    insufficientEvidenceReason?: unknown;
  } | null;
  const recommendation = row.recommendation
    ? CandidateRecommendationZ.safeParse(row.recommendation)
    : null;
  const enrichment = CandidateEnrichmentStatusZ.safeParse(row.enrichmentStatus);
  const decision = row.decision ? CandidateDecisionZ.safeParse(row.decision) : null;
  const evidence = Array.isArray(review?.evidence)
    ? review.evidence
        .map((e) => EvidencePostZ.safeParse(e))
        .filter((r): r is { success: true; data: ReturnType<typeof EvidencePostZ.parse> } => r.success)
        .map((r) => r.data)
    : [];
  return {
    id: row.id,
    channelId: row.channelId,
    platform: row.platform as Platform,
    handle: row.handle,
    url: typeof prov.url === 'string' ? prov.url : '',
    title: typeof prov.title === 'string' ? prov.title : '',
    alreadyKnown: prov.alreadyKnown === true,
    sourceQueries: Array.isArray(prov.sourceQueries)
      ? prov.sourceQueries.filter((q): q is string => typeof q === 'string')
      : [],
    enrichmentStatus: enrichment.success ? enrichment.data : 'new',
    score: toScore(row.score),
    recommendation: recommendation?.success ? recommendation.data : null,
    rationale: typeof review?.rationale === 'string' ? review.rationale : '',
    riskNotes: Array.isArray(review?.riskNotes)
      ? review.riskNotes.filter((n): n is string => typeof n === 'string')
      : [],
    evidence,
    insufficientEvidenceReason:
      typeof review?.insufficientEvidenceReason === 'string'
        ? review.insufficientEvidenceReason
        : null,
    decision: decision?.success ? decision.data : null,
    followers,
    hasProfile: bloggerProfileId != null,
    bloggerProfileId,
  };
}

export const discoveryGuidedService = {
  async create(
    input: GuidedRunCreateInput,
    createdById: string | null,
  ): Promise<{ id: string }> {
    const prisma = getPrisma();
    const queues = getQueues();
    const snapshot = await resolveInputSnapshot(input);
    const run = await prisma.discoveryRun.create({
      data: {
        campaignId: snapshot.campaignId,
        input: snapshot as object,
        status: 'pending',
        plannedQueries: [],
        trace: [],
        summary: zeroSummary(snapshot.budgets) as object,
        createdById,
      },
    });
    await queues.guidedDiscovery.add('process', { runId: run.id });
    return { id: run.id };
  },

  async list(): Promise<GuidedRunListItem[]> {
    const prisma = getPrisma();
    const rows = await prisma.discoveryRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        status: true,
        createdAt: true,
        completedAt: true,
        campaignId: true,
        input: true,
        summary: true,
      },
    });
    return rows.map((row) => {
      const snapshot = parseSnapshot(row.input);
      const summary = parseSummary(row.summary, snapshot.budgets);
      return GuidedRunListItemZ.parse({
        id: row.id,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        campaignId: row.campaignId,
        briefPreview: briefPreview(snapshot.brief),
        platform: snapshot.platform,
        summary,
      });
    });
  },

  async get(id: string): Promise<GuidedRunDetail> {
    const prisma = getPrisma();
    const row = (await prisma.discoveryRun.findUnique({
      where: { id },
    })) as RunRow | null;
    if (!row) throw Errors.notFound('discovery_run', id);

    const candidateRows = (await prisma.discoveryRunCandidate.findMany({
      where: { runId: id },
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
    })) as unknown as CandidateRow[];

    // Batch-load channel followers + which channels have a profile so we
    // don't N+1 per candidate.
    const channelIds = candidateRows
      .map((c) => c.channelId)
      .filter((c): c is string => Boolean(c));
    const [channels, profiles] = await Promise.all([
      channelIds.length
        ? prisma.channel.findMany({
            where: { id: { in: channelIds } },
            select: { id: true, followers: true },
          })
        : Promise.resolve([] as { id: string; followers: number | null }[]),
      channelIds.length
        ? prisma.bloggerProfile.findMany({
            where: { channelId: { in: channelIds } },
            select: { id: true, channelId: true },
          })
        : Promise.resolve([] as { id: string; channelId: string | null }[]),
    ]);
    const followersByChannel = new Map(channels.map((c) => [c.id, c.followers]));
    const profileByChannel = new Map(
      profiles
        .filter((p): p is { id: string; channelId: string } => Boolean(p.channelId))
        .map((p) => [p.channelId, p.id]),
    );

    const snapshot = parseSnapshot(row.input);
    const summary = parseSummary(row.summary, snapshot.budgets);
    const plannedQueries = Array.isArray(row.plannedQueries)
      ? row.plannedQueries
          .map((q) => PlannedQueryZ.safeParse(q))
          .filter((r): r is { success: true; data: ReturnType<typeof PlannedQueryZ.parse> } => r.success)
          .map((r) => r.data)
      : [];
    const trace = Array.isArray(row.trace)
      ? row.trace
          .map((e) => DiscoveryTraceEventZ.safeParse(e))
          .filter((r): r is { success: true; data: ReturnType<typeof DiscoveryTraceEventZ.parse> } => r.success)
          .map((r) => r.data)
      : [];

    return GuidedRunDetailZ.parse({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      campaignId: row.campaignId,
      input: snapshot,
      plannedQueries,
      trace,
      candidates: candidateRows.map((c) =>
        toCandidate(
          c,
          c.channelId ? followersByChannel.get(c.channelId) ?? null : null,
          c.channelId ? profileByChannel.get(c.channelId) ?? null : null,
        ),
      ),
      summary,
    });
  },

  async candidateAction(
    runId: string,
    candidateId: string,
    body: CandidateAction,
  ): Promise<{ ok: true }> {
    const prisma = getPrisma();
    const candidate = await prisma.discoveryRunCandidate.findFirst({
      where: { id: candidateId, runId },
      select: { id: true, channelId: true },
    });
    if (!candidate) throw Errors.notFound('discovery_run_candidate', candidateId);

    if (body.action === 'scrape_refresh') {
      if (!candidate.channelId) {
        throw Errors.badRequest('candidate has no linked channel to scrape');
      }
      await getQueues().channelScrape.add('scrape', { channelId: candidate.channelId });
      await prisma.discoveryRunCandidate.update({
        where: { id: candidate.id },
        data: { enrichmentStatus: 'pending_enrichment' },
      });
      return { ok: true };
    }

    const decision =
      body.action === 'save'
        ? 'saved'
        : body.action === 'shortlist'
          ? 'shortlisted'
          : body.action === 'reject'
            ? 'rejected'
            : null; // clear
    await prisma.discoveryRunCandidate.update({
      where: { id: candidate.id },
      data: { decision },
    });
    return { ok: true };
  },
};
