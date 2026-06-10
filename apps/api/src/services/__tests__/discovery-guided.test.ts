import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '@nosquare/shared/errors';
import { GuidedRunCreateInputZ } from '@nosquare/shared';

/**
 * Guided discovery service (ajtbd-guided-blogger-discovery, task 1.4).
 *
 * create() resolves the campaign goal/AJTBD or a manual brief into a stable
 * input snapshot, persists a `DiscoveryRun(pending)`, and enqueues the
 * worker once. get/list read rows back through the prisma mock. The
 * candidate actions persist operator decisions or request a scrape refresh.
 * The async planner/search/review pipeline is the worker's concern.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    campaign: { findUnique: vi.fn() },
    discoveryRun: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    discoveryRunCandidate: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    channel: { findMany: vi.fn() },
    bloggerProfile: { findMany: vi.fn() },
    contact: { findMany: vi.fn(async (_args: unknown): Promise<Array<{ id: string; roleGuess?: string; type?: string; confidence?: number }>> => []) },
  };
  const guidedAdd = vi.fn(async () => ({}));
  const scrapeAdd = vi.fn(async () => ({}));
  const addContacts = vi.fn(async () => ({ added: 1, requested: 1, chatsCreated: 1, suggestionsQueued: 1, blocker: null }));
  const flagGet = vi.fn(() => true);
  return { prisma, guidedAdd, scrapeAdd, addContacts, flagGet };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('../../queues.js', () => ({
  getQueues: () => ({
    guidedDiscovery: { add: mocks.guidedAdd },
    channelScrape: { add: mocks.scrapeAdd },
  }),
}));
vi.mock('../campaigns.js', () => ({
  campaignsService: { addContacts: mocks.addContacts },
}));
vi.mock('../../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: mocks.flagGet }),
}));

import { discoveryGuidedService } from '../discovery-guided.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.channel.findMany.mockResolvedValue([]);
  mocks.prisma.bloggerProfile.findMany.mockResolvedValue([]);
  mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([]);
  mocks.prisma.discoveryRun.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.contact.findMany.mockResolvedValue([]);
  mocks.flagGet.mockReturnValue(true);
  mocks.addContacts.mockResolvedValue({ added: 1, requested: 1, chatsCreated: 1, suggestionsQueued: 1, blocker: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GuidedRunCreateInputZ validation', () => {
  it('rejects input with neither campaignId nor brief', () => {
    expect(GuidedRunCreateInputZ.safeParse({}).success).toBe(false);
  });

  it('accepts a manual brief', () => {
    const r = GuidedRunCreateInputZ.safeParse({ brief: 'B2B fintech founders' });
    expect(r.success).toBe(true);
  });

  it('accepts a campaignId', () => {
    const r = GuidedRunCreateInputZ.safeParse({ campaignId: 'camp_1' });
    expect(r.success).toBe(true);
  });

  it('clamps budgets within bounds', () => {
    const r = GuidedRunCreateInputZ.parse({ brief: 'fintech', budgets: { maxQueries: 8 } });
    expect(r.budgets?.maxQueries).toBe(8);
  });
});

describe('discoveryGuidedService.create', () => {
  it('persists a manual-brief run snapshot and enqueues the worker', async () => {
    mocks.prisma.discoveryRun.create.mockResolvedValue({ id: 'run_1' });
    const out = await discoveryGuidedService.create(
      { brief: 'B2B fintech founders in Telegram', platform: 'telegram', geo: [] },
      'user_1',
    );
    expect(out).toEqual({ id: 'run_1' });
    expect(mocks.prisma.campaign.findUnique).not.toHaveBeenCalled();
    const createArg = mocks.prisma.discoveryRun.create.mock.calls[0]![0] as {
      data: { status: string; campaignId: string | null; input: { brief: string; ajtbd: unknown; budgets: { maxQueries: number } } };
    };
    expect(createArg.data.status).toBe('pending');
    expect(createArg.data.campaignId).toBeNull();
    expect(createArg.data.input.brief).toBe('B2B fintech founders in Telegram');
    expect(createArg.data.input.ajtbd).toBeNull();
    expect(createArg.data.input.budgets.maxQueries).toBeGreaterThan(0);
    expect(mocks.guidedAdd).toHaveBeenCalledWith('process', { runId: 'run_1' });
  });

  it('resolves campaign goal/AJTBD into the snapshot when campaignId is supplied', async () => {
    mocks.prisma.campaign.findUnique.mockResolvedValue({
      id: 'camp_1',
      goal: { job: 'find bloggers', desired_outcome: 'shortlist' },
      goalText: 'Найти блогеров для финтех клиента',
      valueProp: 'vp',
      type: { key: 'agency_sourcing' },
    });
    mocks.prisma.discoveryRun.create.mockResolvedValue({ id: 'run_2' });
    await discoveryGuidedService.create({ campaignId: 'camp_1', geo: [] }, 'user_1');
    const createArg = mocks.prisma.discoveryRun.create.mock.calls[0]![0] as {
      data: { campaignId: string | null; input: { brief: string; ajtbd: { job: string } | null } };
    };
    expect(createArg.data.campaignId).toBe('camp_1');
    expect(createArg.data.input.brief).toBe('Найти блогеров для финтех клиента');
    expect(createArg.data.input.ajtbd).not.toBeNull();
    expect(mocks.guidedAdd).toHaveBeenCalledWith('process', { runId: 'run_2' });
  });

  it('throws not_found for an unknown campaign and does not enqueue', async () => {
    mocks.prisma.campaign.findUnique.mockResolvedValue(null);
    try {
      await discoveryGuidedService.create({ campaignId: 'nope', geo: [] }, 'user_1');
      expect.unreachable();
    } catch (e) {
      expect(isAppError(e)).toBe(true);
    }
    expect(mocks.guidedAdd).not.toHaveBeenCalled();
  });
});

describe('discoveryGuidedService.get', () => {
  it('serializes run detail with candidates, evidence and provenance', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue({
      id: 'run_1',
      status: 'done',
      createdAt: now,
      completedAt: now,
      campaignId: null,
      input: {
        campaignId: null,
        brief: 'fintech',
        ajtbd: null,
        platform: 'telegram',
        geo: [],
        language: null,
        budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 },
      },
      plannedQueries: [{ query: 'fintech telegram', platform: 'telegram', rationale: 'r', signal: 's', negativeTerms: [], confidence: 0.7 }],
      trace: [{ ts: now.toISOString(), stage: 'search.completed', status: 'ok', message: 'done', resultCount: 5, candidateCount: 2 }],
      summary: { plannedQueries: 1, executedQueries: 1, failedQueries: 0, candidatesFound: 1, candidatesReviewed: 1, candidatesSkipped: 0, recommended: 1, newChannels: 1, knownChannels: 0, budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 } },
    });
    mocks.prisma.discoveryRunCandidate.findMany.mockResolvedValue([
      {
        id: 'cand_1',
        channelId: 'ch_1',
        platform: 'telegram',
        handle: 'fintechguru',
        provenance: { sourceQueries: ['fintech telegram'], url: 'https://t.me/fintechguru', title: 'Fintech Guru', alreadyKnown: false },
        enrichmentStatus: 'enriched',
        review: { rationale: 'strong match', riskNotes: ['low followers'], evidence: [{ postId: '1', date: null, snippet: 'about fintech', urls: [], why: 'topic match' }], insufficientEvidenceReason: null },
        score: 0.82,
        recommendation: 'strong_fit',
        decision: null,
      },
    ]);
    mocks.prisma.channel.findMany.mockResolvedValue([{ id: 'ch_1', followers: 1200 }]);
    mocks.prisma.bloggerProfile.findMany.mockResolvedValue([{ id: 'prof_1', channelId: 'ch_1' }]);

    const detail = await discoveryGuidedService.get('run_1');
    expect(detail.id).toBe('run_1');
    expect(detail.plannedQueries).toHaveLength(1);
    expect(detail.trace[0]!.stage).toBe('search.completed');
    expect(detail.candidates).toHaveLength(1);
    const c = detail.candidates[0]!;
    expect(c.recommendation).toBe('strong_fit');
    expect(c.score).toBeCloseTo(0.82);
    expect(c.evidence[0]!.snippet).toBe('about fintech');
    expect(c.sourceQueries).toEqual(['fintech telegram']);
    expect(c.followers).toBe(1200);
    expect(c.hasProfile).toBe(true);
    expect(c.bloggerProfileId).toBe('prof_1');
  });

  it('throws not_found for a missing run', async () => {
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue(null);
    try {
      await discoveryGuidedService.get('nope');
      expect.unreachable();
    } catch (e) {
      expect(isAppError(e)).toBe(true);
    }
  });

  it('serialized detail leaks no secret material', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue({
      id: 'run_1',
      status: 'done',
      createdAt: now,
      completedAt: now,
      campaignId: null,
      input: { campaignId: null, brief: 'fintech', ajtbd: null, platform: null, geo: [], language: null, budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 } },
      plannedQueries: [],
      trace: [{ ts: now.toISOString(), stage: 'search.completed', status: 'ok', message: 'ok', resultCount: 1, candidateCount: 1 }],
      summary: { plannedQueries: 0, executedQueries: 1, failedQueries: 0, candidatesFound: 0, candidatesReviewed: 0, candidatesSkipped: 0, recommended: 0, newChannels: 0, knownChannels: 0, budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 } },
    });
    const detail = await discoveryGuidedService.get('run_1');
    const serialized = JSON.stringify(detail).toLowerCase();
    expect(serialized).not.toContain('apikey');
    expect(serialized).not.toContain('folderid');
    expect(serialized).not.toContain('configencrypted');
  });
});

describe('discoveryGuidedService.list', () => {
  it('returns compact rows with brief preview and summary counts (no trace/candidates)', async () => {
    mocks.prisma.discoveryRun.findMany.mockResolvedValue([
      {
        id: 'run_2',
        status: 'done',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        completedAt: new Date('2026-06-01T12:05:00.000Z'),
        campaignId: 'camp_1',
        input: { campaignId: 'camp_1', brief: 'B2B fintech founders in Telegram', ajtbd: null, platform: 'telegram', geo: [], language: null, budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 } },
        summary: { plannedQueries: 3, executedQueries: 3, failedQueries: 0, candidatesFound: 7, candidatesReviewed: 5, candidatesSkipped: 0, recommended: 2, newChannels: 4, knownChannels: 3, budgets: { maxQueries: 8, maxResultsPerQuery: 20, maxCandidates: 40, maxReviewed: 15 } },
      },
    ]);
    const out = await discoveryGuidedService.list();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('run_2');
    expect(out[0]!.briefPreview).toContain('fintech');
    expect(out[0]!.platform).toBe('telegram');
    expect(out[0]!.summary.recommended).toBe(2);
    expect((out[0] as unknown as { trace?: unknown }).trace).toBeUndefined();
    expect((out[0] as unknown as { candidates?: unknown }).candidates).toBeUndefined();
  });
});

describe('discoveryGuidedService.candidateAction', () => {
  it('persists a save decision', async () => {
    mocks.prisma.discoveryRunCandidate.findFirst.mockResolvedValue({ id: 'cand_1', channelId: 'ch_1' });
    mocks.prisma.discoveryRunCandidate.update.mockResolvedValue({});
    await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'save' });
    const updArg = mocks.prisma.discoveryRunCandidate.update.mock.calls[0]![0] as { data: { decision: string | null } };
    expect(updArg.data.decision).toBe('saved');
  });

  it('scrape_refresh re-arms the candidate, bumps generation, reopens a done run', async () => {
    mocks.prisma.discoveryRunCandidate.findFirst.mockResolvedValue({ id: 'cand_1', channelId: 'ch_1', provenance: { scrapeGeneration: 2 }, decision: null });
    mocks.prisma.discoveryRunCandidate.update.mockResolvedValue({});
    await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'scrape_refresh' });
    // attempts:1 so the final-failure hook fires promptly.
    expect(mocks.scrapeAdd).toHaveBeenCalledWith('scrape', { channelId: 'ch_1' }, { attempts: 1 });
    const updArg = mocks.prisma.discoveryRunCandidate.update.mock.calls[0]![0] as { data: { enrichmentStatus: string; reviewClaimedAt: Date | null; provenance: { scrapeGeneration: number } } };
    expect(updArg.data.enrichmentStatus).toBe('pending_enrichment');
    expect(updArg.data.reviewClaimedAt).toBeNull();
    expect(updArg.data.provenance.scrapeGeneration).toBe(3);
    // reopens a terminal run (done → enriching).
    expect(mocks.prisma.discoveryRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run_1', status: 'done' }, data: expect.objectContaining({ status: 'enriching' }) }),
    );
    // BUG #3: the run MUST be reopened BEFORE the scrape is enqueued, otherwise a
    // fast scrape could call triggerGuidedReview while the run is still `done`
    // (that hook ignores done runs) and strand the re-armed candidate.
    const reopenOrder = mocks.prisma.discoveryRun.updateMany.mock.invocationCallOrder[0]!;
    const scrapeOrder = mocks.scrapeAdd.mock.invocationCallOrder[0]!;
    expect(reopenOrder).toBeLessThan(scrapeOrder);
  });

  it('throws not_found for a candidate outside the run', async () => {
    mocks.prisma.discoveryRunCandidate.findFirst.mockResolvedValue(null);
    try {
      await discoveryGuidedService.candidateAction('run_1', 'nope', { action: 'reject' });
      expect.unreachable();
    } catch (e) {
      expect(isAppError(e)).toBe(true);
    }
  });
});

describe('discoveryGuidedService.candidateAction launch', () => {
  beforeEach(() => {
    mocks.prisma.discoveryRunCandidate.findFirst.mockResolvedValue({ id: 'cand_1', channelId: 'ch_1', provenance: {}, decision: 'shortlisted' });
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue({ campaignId: 'camp_run' });
    mocks.prisma.campaign.findUnique.mockResolvedValue({ id: 'camp_run', type: { key: 'agency_sourcing' } });
    mocks.prisma.contact.findMany.mockResolvedValue([
      { id: 'contact_1', roleGuess: 'ad_manager', type: 'tg_username', confidence: 0.8 },
    ]);
    mocks.prisma.discoveryRunCandidate.update.mockResolvedValue({});
  });

  it('selects ad_manager/owner contacts, prepares (no send), sets decision=launched', async () => {
    const res = await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'launch', campaignId: 'camp_x' });
    // role filter = ad_manager + owner only.
    const where = (mocks.prisma.contact.findMany.mock.calls[0]![0] as { where: { roleGuess: { in: string[] } } }).where;
    expect(where.roleGuess.in).toEqual(['ad_manager', 'owner']);
    // prepareOnly forces no auto-send.
    expect(mocks.addContacts).toHaveBeenCalledWith('camp_x', ['contact_1'], { prepareOnly: true });
    const updArg = mocks.prisma.discoveryRunCandidate.update.mock.calls.at(-1)![0] as { data: { decision: string; launchedCampaignId: string } };
    expect(updArg.data.decision).toBe('launched');
    expect(updArg.data.launchedCampaignId).toBe('camp_x');
    expect((res as { suggestionsQueued: number }).suggestionsQueued).toBe(1);
  });

  it('launches ONE chat to the best contact — ad_manager wins over owner', async () => {
    // Regression: channel publishes an explicit ad contact ("Реклама/сотр-во:
    // @Julia_s_vami", ad_manager) AND the owner's personal account ("Мама Оля
    // https://t.me/top_mama_olia", owner). Launch must DM only the ad manager,
    // not also the personal owner — i.e. addContacts gets exactly one id.
    mocks.prisma.contact.findMany.mockResolvedValue([
      { id: 'owner_olia', roleGuess: 'owner', type: 'tg_link', confidence: 0.9 },
      { id: 'ad_julia', roleGuess: 'ad_manager', type: 'tg_username', confidence: 0.7 },
    ]);
    await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'launch', campaignId: 'camp_x' });
    expect(mocks.addContacts).toHaveBeenCalledWith('camp_x', ['ad_julia'], { prepareOnly: true });
  });

  it('falls back to the owner when no ad_manager exists', async () => {
    mocks.prisma.contact.findMany.mockResolvedValue([
      { id: 'owner_only', roleGuess: 'owner', type: 'tg_username', confidence: 0.6 },
    ]);
    await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'launch', campaignId: 'camp_x' });
    expect(mocks.addContacts).toHaveBeenCalledWith('camp_x', ['owner_only'], { prepareOnly: true });
  });

  it('resolves campaignId from the run when the body omits it', async () => {
    await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'launch' });
    expect(mocks.addContacts).toHaveBeenCalledWith('camp_run', ['contact_1'], { prepareOnly: true });
  });

  it('errors when both body campaignId and run campaign are absent', async () => {
    mocks.prisma.discoveryRun.findUnique.mockResolvedValue({ campaignId: null });
    await expect(
      discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'launch' }),
    ).rejects.toMatchObject({});
    expect(mocks.addContacts).not.toHaveBeenCalled();
  });

  it('agency campaign with flag off → 422', async () => {
    mocks.flagGet.mockReturnValue(false);
    try {
      await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'launch', campaignId: 'camp_x' });
      expect.unreachable();
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      expect((e as { statusCode: number }).statusCode).toBe(422);
    }
    expect(mocks.addContacts).not.toHaveBeenCalled();
  });

  it('no business/ad contact → 400, no addContacts', async () => {
    mocks.prisma.contact.findMany.mockResolvedValue([]);
    try {
      await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'launch', campaignId: 'camp_x' });
      expect.unreachable();
    } catch (e) {
      expect(isAppError(e)).toBe(true);
    }
    expect(mocks.addContacts).not.toHaveBeenCalled();
  });

  it('candidate without a channel → 400', async () => {
    mocks.prisma.discoveryRunCandidate.findFirst.mockResolvedValue({ id: 'cand_1', channelId: null, provenance: {}, decision: 'saved' });
    try {
      await discoveryGuidedService.candidateAction('run_1', 'cand_1', { action: 'launch', campaignId: 'camp_x' });
      expect.unreachable();
    } catch (e) {
      expect(isAppError(e)).toBe(true);
    }
    expect(mocks.addContacts).not.toHaveBeenCalled();
  });
});
