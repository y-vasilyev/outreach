/**
 * LIVE, CREDIT-SPENDING end-to-end test for the guided-discovery evidence loop.
 * =============================================================================
 *
 * This proves the full "guided discovery → evidence-grounded review → запуск в
 * работу" loop against the REAL external APIs:
 *
 *   - REAL Yandex Search        (planner queries → actual candidate channels)
 *   - REAL OpenRouter planner    (`discovery_query_planner` agent_config v1)
 *   - REAL OpenRouter reviewer    (`blogger_discovery_reviewer` agent_config v1)
 *
 * The ONLY simulated boundary is ScrapeCreators/GramJS channel scraping — we
 * have no ScrapeCreators key in this environment, so instead of running the
 * `channel-scrape` worker we write realistic public Russian-language posts onto
 * each candidate Channel directly (status='scraped' + rawData.posts). This is
 * the same shape the real scrape worker persists (see channel-scrape.ts), so
 * the reviewer still grounds its recommendation on real public-evidence text.
 * Everything else — search, the LLM planner, the LLM reviewer, the DB state
 * machine, and the launch-into-work bridge — is the real production code path.
 *
 * SKIP BY DEFAULT. A normal `pnpm test` does NOT set the LIVE_* env, so the
 * whole suite is skipped and spends ZERO credits. It must never run in default
 * CI. To run it live (spends a little OpenRouter + Yandex credit):
 *
 *   cd /root/projects/outreach && set -a && . ./.env && set +a \
 *     && DATABASE_URL="postgresql://nosquare:nosquare123@localhost:5433/outreach_e2e?schema=public" \
 *        REDIS_URL="redis://localhost:6379" \
 *        LIVE_DISCOVERY_E2E=1 \
 *        pnpm --filter @nosquare/workers test guidedDiscoveryLive
 *
 * Budgets are kept tiny (2 queries / 5 results / 3 candidates / 2 reviewed) to
 * bound spend.
 *
 * CROSS-APP IMPORT NOTE: the worker handlers live in apps/workers and the
 * launch service lives in apps/api. Both share the SAME `@nosquare/db`
 * singleton (`getPrisma()`), so DB writes from one are visible to the other.
 * We import the apps/api `discoveryGuidedService` via a relative path with a
 * dynamic `import()` INSIDE the test body — a static top-level import would run
 * apps/api's strict env.ts validation at module-load even when the suite is
 * skipped. Dynamic import defers that to the live run (where `.env` is sourced).
 * moduleResolution is "Bundler" so the `.js` specifiers inside apps/api resolve
 * to their `.ts` sources under vitest. This let a single file drive BOTH apps.
 */

import { afterAll, describe, expect, it } from 'vitest';
// Type-only import (erased at runtime, so it does NOT trigger @nosquare/db's
// runtime env validation when the suite is skipped) — used to type the channel
// snapshot we restore in teardown with Prisma's real `ChannelStatus` enum.
import type { ChannelStatus } from '@nosquare/db';

// Cross-app dynamic import helper. The apps/api modules live OUTSIDE the
// workers `rootDir`, so a statically-resolvable specifier makes `tsc` pull all
// of apps/api into the workers program (TS6059). Building the specifier at
// runtime keeps tsc from resolving it (the import is `any`), while vitest's
// "Bundler" resolution still loads the real `.ts` at run time. Both apps share
// the same `@nosquare/db` singleton, so the DB state is visible across the line.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const importApi = (rel: string): Promise<any> => {
  const base = ['..', '..', '..', 'api', 'src'].join('/');
  return import(/* @vite-ignore */ `${base}/${rel}`);
};

// Guard env BEFORE any module that validates it loads. The worker handlers only
// need DATABASE_URL/REDIS_URL/ENCRYPTION_KEY (provided by _test-env.ts in unit
// runs); the apps/api service additionally needs JWT_SECRET. In the live run
// `.env` provides all of these; this `??=` only fills gaps so the dynamic
// import of apps/api never crashes on a missing-but-irrelevant var.
process.env.JWT_SECRET ??= 'test-jwt-secret-32-chars-minimum-yes';

const ENABLED = Boolean(
  process.env.LIVE_DISCOVERY_E2E &&
    process.env.OPENROUTER_API_KEY &&
    process.env.YANDEX_SEARCH_API_KEY &&
    process.env.YANDEX_SEARCH_FOLDER_ID,
);

// Realistic public Russian posts per simulated scrape — grounded in the brief
// ("умный дом / бытовая техника") so the REAL reviewer has genuine evidence.
const SIMULATED_POSTS = [
  {
    id: '101',
    date: '2026-05-20',
    text: 'Обзор новой роботизированной мойки окон Hutt — тестим на панорамных окнах в умном доме. Подписчики часто спрашивают про интеграцию с Яндекс Алисой, разбираем сценарии автоматизации.',
    urls: ['https://t.me/example/101'],
  },
  {
    id: '102',
    date: '2026-05-24',
    text: 'Собрали сцену умного дома: датчики протечки, умные розетки и управление кондиционером через приложение. По вопросам рекламы и интеграций — менеджер @ad_manager_example.',
    urls: [],
  },
  {
    id: '103',
    date: '2026-05-28',
    text: 'Сравнение роботов-пылесосов с лидаром: какой выбрать для квартиры с коврами. Бытовая техника для умного дома — наш основной формат контента.',
    urls: ['https://t.me/example/103'],
  },
];

describe.skipIf(!ENABLED)('guided-discovery evidence loop — LIVE e2e', () => {
  // Track BullMQ connections / created row ids for teardown.
  const openConnections: Array<{ close: () => Promise<void> }> = [];
  const created = {
    runId: null as string | null,
    // Channels THIS run created (source === `guided:${run.id}`). ONLY these are
    // safe to mutate (simulated scrape) and delete in teardown. A run may REUSE
    // a pre-existing channel (provenance.alreadyKnown===true) — we must never
    // overwrite or delete those; their original fields are snapshotted and
    // restored instead (see `reusedSnapshots`).
    channelIds: [] as string[],
    contactIds: [] as string[],
    conversationIds: [] as string[],
    campaignId: null as string | null,
    tgAccountId: null as string | null,
  };
  // Previous value of the `agency_sourcing` feature flag, captured BEFORE we
  // enable it, so teardown restores whatever it was (NOT a hard-coded false).
  // `undefined` = we never touched it.
  let prevAgencyFlag: boolean | undefined;
  // Snapshots of fields we mutate on REUSED (pre-existing) channels, restored in
  // teardown so we never corrupt a channel this run did not create.
  const reusedSnapshots: Array<{
    id: string;
    status: ChannelStatus;
    title: string | null;
    description: string | null;
    language: string | null;
    followers: number | null;
    scrapedAt: Date | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawData: any;
  }> = [];

  afterAll(async () => {
    // Best-effort cleanup; never let teardown fail the run.
    try {
      const { getPrisma } = await import('@nosquare/db');
      const prisma = getPrisma();
      // Delete conversations referencing our contacts/campaign FIRST (the launch
      // step may have created one even if a later assertion threw before we
      // tracked its id) so the contact/campaign deletes don't hit the FK.
      const convWhere = {
        OR: [
          ...(created.conversationIds.length ? [{ id: { in: created.conversationIds } }] : []),
          ...(created.contactIds.length ? [{ contactId: { in: created.contactIds } }] : []),
          ...(created.campaignId ? [{ campaignId: created.campaignId }] : []),
        ],
      };
      if (convWhere.OR.length) {
        const convs = await prisma.conversation.findMany({ where: convWhere, select: { id: true } });
        const convIds = convs.map((c) => c.id);
        if (convIds.length) {
          await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
          await prisma.suggestion.deleteMany({ where: { conversationId: { in: convIds } } }).catch(() => {});
          await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
        }
      }
      if (created.runId) {
        await prisma.discoveryRunCandidate.deleteMany({ where: { runId: created.runId } });
        await prisma.discoveryRun.deleteMany({ where: { id: created.runId } });
      }
      if (created.contactIds.length) {
        await prisma.contact.deleteMany({ where: { id: { in: created.contactIds } } });
      }
      // Restore any REUSED (pre-existing) channels we simulated-scraped onto, so
      // we never corrupt a channel this run did not create.
      for (const snap of reusedSnapshots) {
        await prisma.channel
          .update({
            where: { id: snap.id },
            data: {
              status: snap.status,
              title: snap.title,
              description: snap.description,
              language: snap.language,
              followers: snap.followers,
              scrapedAt: snap.scrapedAt,
              rawData: (snap.rawData ?? null) as object,
            },
          })
          .catch(() => {});
      }
      // Delete ONLY channels this run created (source === `guided:${run.id}`).
      if (created.channelIds.length) {
        await prisma.channel.deleteMany({ where: { id: { in: created.channelIds } } });
      }
      if (created.campaignId) {
        await prisma.campaign.deleteMany({ where: { id: created.campaignId } });
      }
      if (created.tgAccountId) {
        await prisma.tgAccount.deleteMany({ where: { id: created.tgAccountId } });
      }
      // Restore the agency_sourcing flag to whatever it was BEFORE the test
      // enabled it (not a hard-coded false), and only if we actually touched it.
      // Runs even if the test threw mid-way.
      if (prevAgencyFlag !== undefined) {
        await prisma.featureFlag
          .update({ where: { key: 'agency_sourcing' }, data: { enabled: prevAgencyFlag } })
          .catch(() => {});
      }
      await prisma.$disconnect().catch(() => {});
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('teardown warning:', (err as Error).message);
    }
    for (const c of openConnections) {
      await c.close().catch(() => {});
    }
    // Close BullMQ/redis connections opened by the worker handlers + apps/api so
    // vitest exits cleanly. `getRedis()` is a shared ioredis singleton reused by
    // every BullMQ Queue the handlers created; disconnecting it (and the apps/api
    // pub/sub + feature-flags subscriber) drops the open handles.
    try {
      const workerRedis = await import('../redis.js');
      workerRedis.getRedis().disconnect();
    } catch {
      /* ignore */
    }
    try {
      const apiRedis = await importApi('redis.js');
      apiRedis.getRedis().disconnect();
    } catch {
      /* ignore */
    }
  });

  it(
    'plans (real Yandex+LLM) → reviews on real evidence → launches under the human-approval gate',
    async () => {
      const { getPrisma } = await import('@nosquare/db');
      const { GuidedRunInputSnapshotZ } = await import('@nosquare/shared');
      const guided = await import('../queues/guided-discovery.js');
      const review = await import('../queues/guided-discovery-review.js');
      const prisma = getPrisma();

      const admin = await prisma.user.findFirstOrThrow({
        where: { email: 'admin@nosquare.local' },
        select: { id: true },
      });

      // ── 1) Create the run with a concrete Russian brief + tiny budgets. ──
      const snapshot = GuidedRunInputSnapshotZ.parse({
        campaignId: null,
        brief:
          'Ищу телеграм-каналы про умный дом и бытовую технику: обзоры роботов-пылесосов, ' +
          'умных розеток, датчиков, сценариев автоматизации жилья. Аудитория — россияне, ' +
          'интересующиеся техникой для дома.',
        ajtbd: null,
        platform: 'telegram',
        geo: ['RU'],
        language: 'ru',
        budgets: { maxQueries: 2, maxResultsPerQuery: 5, maxCandidates: 3, maxReviewed: 2 },
      });

      const run = await prisma.discoveryRun.create({
        data: {
          campaignId: null,
          input: snapshot as object,
          status: 'pending',
          plannedQueries: [],
          trace: [],
          summary: { budgets: snapshot.budgets } as object,
          createdById: admin.id,
        },
        select: { id: true },
      });
      created.runId = run.id;

      // ── 2) Run phase 1: real planner + real Yandex search. ──
      await guided.__internal.handleGuidedDiscovery({ runId: run.id });

      const afterPlan = await prisma.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
      const planned = (afterPlan.plannedQueries as unknown[]) ?? [];
      const summary1 = afterPlan.summary as { candidatesFound?: number };
      // eslint-disable-next-line no-console
      console.log('\n=== PHASE 1 (real Yandex + real planner) ===');
      // eslint-disable-next-line no-console
      console.log('planned queries:', JSON.stringify(planned, null, 2));
      // eslint-disable-next-line no-console
      console.log('run status:', afterPlan.status, '| candidatesFound:', summary1.candidatesFound);

      expect(planned.length).toBeGreaterThan(0);
      expect(summary1.candidatesFound ?? 0).toBeGreaterThan(0);
      // New-niche candidates are left pending → run goes to `enriching`.
      expect(afterPlan.status).toBe('enriching');

      const candidates = await prisma.discoveryRunCandidate.findMany({
        where: { runId: run.id },
        select: { id: true, channelId: true, handle: true, platform: true, provenance: true },
      });
      expect(candidates.length).toBeGreaterThan(0);
      // Track ONLY channels this run CREATED (source === `guided:${run.id}`) for
      // deletion in teardown. A reused, pre-existing channel must never be
      // deleted. `provenance.alreadyKnown===false` AND a `guided:` source both
      // mark a run-created channel; we confirm via the channel's `source` so a
      // race-fallback "treat as known" candidate is never mis-deleted.
      const createdChannelIdSet = new Set<string>();
      for (const c of candidates) {
        if (!c.channelId) continue;
        const ch = await prisma.channel.findUnique({
          where: { id: c.channelId },
          select: { source: true },
        });
        if (ch?.source === `guided:${run.id}`) {
          createdChannelIdSet.add(c.channelId);
          if (!created.channelIds.includes(c.channelId)) created.channelIds.push(c.channelId);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        'candidates:',
        candidates.map((c) => `${c.platform}:${c.handle}`).join(', '),
      );

      // ── 3) SIMULATE SCRAPE (the one mocked boundary). ──
      // We have no ScrapeCreators key, so instead of running the channel-scrape
      // worker we write the public evidence the worker WOULD persist: mark the
      // Channel scraped, give it a title/description, and attach realistic
      // public Russian posts. Only ScrapeCreators is stubbed here — Yandex,
      // the LLM planner (already run) and the LLM reviewer (next) are REAL.
      for (const c of candidates) {
        if (!c.channelId) continue;
        // For a REUSED (pre-existing) channel, snapshot the fields we are about
        // to overwrite so teardown can restore them. We NEVER blindly overwrite
        // a channel this run did not create. (Created channels are fresh and get
        // deleted in teardown, so no snapshot is needed for them.)
        if (!createdChannelIdSet.has(c.channelId)) {
          const before = await prisma.channel.findUniqueOrThrow({
            where: { id: c.channelId },
            select: {
              status: true,
              title: true,
              description: true,
              language: true,
              followers: true,
              scrapedAt: true,
              rawData: true,
            },
          });
          reusedSnapshots.push({ id: c.channelId, ...before });
        }
        await prisma.channel.update({
          where: { id: c.channelId },
          data: {
            status: 'scraped',
            title: `Умный дом и техника — ${c.handle}`,
            description:
              'Канал про умный дом, бытовую технику, роботы-пылесосы и сценарии автоматизации. По рекламе: @ad_manager_example',
            language: 'ru',
            followers: 24000,
            scrapedAt: new Date(),
            rawData: { posts: SIMULATED_POSTS } as object,
          },
        });
      }

      // ── 4) Drive the review path the way the scrape→review hook does:
      // one handleReview job per candidate, scrapeOutcome 'ok'. handleReview is
      // the exact handler the guided-discovery-review worker runs. ──
      for (const c of candidates) {
        await review.__internal.handleReview({
          runId: run.id,
          candidateId: c.id,
          scrapeOutcome: 'ok',
        });
      }

      const afterReview = await prisma.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
      const summary2 = afterReview.summary as {
        candidatesReviewed?: number;
        recommended?: number;
        pendingReview?: number;
      };
      const reviewedRows = await prisma.discoveryRunCandidate.findMany({
        where: { runId: run.id },
        select: {
          id: true,
          channelId: true,
          handle: true,
          score: true,
          recommendation: true,
          review: true,
        },
      });

      // eslint-disable-next-line no-console
      console.log('\n=== PHASE 2 (real OpenRouter reviewer) ===');
      // eslint-disable-next-line no-console
      console.log('run status:', afterReview.status, '| summary:', JSON.stringify(summary2));
      for (const r of reviewedRows) {
        const rv = (r.review ?? {}) as {
          rationale?: string;
          evidence?: Array<{ snippet?: string; why?: string }>;
        };
        // eslint-disable-next-line no-console
        console.log(`\n--- ${r.handle} ---`);
        // eslint-disable-next-line no-console
        console.log('recommendation:', r.recommendation, '| score:', r.score?.toString());
        // eslint-disable-next-line no-console
        console.log('rationale:', rv.rationale);
        // eslint-disable-next-line no-console
        console.log('evidence:', JSON.stringify(rv.evidence, null, 2));
      }

      // The evidence loop must close: enriching → done.
      expect(afterReview.status).toBe('done');
      expect(summary2.candidatesReviewed ?? 0).toBeGreaterThan(0);
      expect(summary2.pendingReview ?? -1).toBe(0);

      // At least one candidate has a real score + recommendation.
      const scored = reviewedRows.filter((r) => r.recommendation != null && r.score != null);
      expect(scored.length).toBeGreaterThan(0);

      // Evidence is grounded: at least one cited snippet must overlap the supplied
      // posts (the reviewer must NOT fabricate evidence). We check that a cited
      // snippet is a substring of one supplied post OR shares a meaningful run of
      // words with it.
      const postTexts = SIMULATED_POSTS.map((p) => p.text);
      const grounded = reviewedRows.some((r) => {
        const ev = ((r.review ?? {}) as { evidence?: Array<{ snippet?: string }> }).evidence ?? [];
        return ev.some((e) => {
          const snip = (e.snippet ?? '').trim();
          if (snip.length < 8) return false;
          return postTexts.some((pt) => {
            if (pt.includes(snip) || snip.includes(pt.slice(0, 40))) return true;
            // Fallback: share a 5+ word phrase.
            const words = snip.split(/\s+/).filter((w) => w.length > 3);
            for (let i = 0; i + 4 < words.length; i++) {
              const phrase = words.slice(i, i + 5).join(' ');
              if (pt.includes(phrase)) return true;
            }
            return false;
          });
        });
      });
      // eslint-disable-next-line no-console
      console.log('\nevidence grounded in supplied posts:', grounded);
      expect(grounded).toBe(true);

      // ── 5) LAUNCH-INTO-WORK under the human-approval gate. ──
      // Enable the agency_sourcing flag in the DB so the apps/api launch path's
      // feature gate passes, then refresh the in-process cache. Capture the
      // PREVIOUS value first so teardown restores it (NOT a hard-coded false),
      // and do so even if a later assertion throws.
      const prevFlag = await prisma.featureFlag.findUnique({
        where: { key: 'agency_sourcing' },
        select: { enabled: true },
      });
      prevAgencyFlag = prevFlag?.enabled ?? false;
      await prisma.featureFlag.update({
        where: { key: 'agency_sourcing' },
        data: { enabled: true },
      });

      // Pick the best-scored candidate that has a linked channel.
      const chosen = [...reviewedRows]
        .filter((r) => r.channelId)
        .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))[0];
      expect(chosen).toBeTruthy();
      const chosenChannelId = chosen!.channelId!;

      // Seed an ACTIVE TgAccount for the outreach pool.
      const acct = await prisma.tgAccount.create({
        data: {
          label: 'e2e-live-outreach',
          phone: `+7999${Date.now().toString().slice(-7)}`,
          status: 'active',
          role: 'both',
        },
        select: { id: true },
      });
      created.tgAccountId = acct.id;

      // Seed an agency_sourcing campaign with the pool.
      const campaign = await prisma.campaign.create({
        data: {
          name: 'e2e-live-agency-sourcing',
          goalText: 'Собрать прайсы и охваты у блогеров про умный дом',
          valueProp: 'Рекламный запрос к явно опубликованным business/ad контактам',
          typeId: 'agency_sourcing',
          outreachAccountPool: [acct.id],
          defaultMode: 'assisted',
          status: 'running',
          createdById: admin.id,
        },
        select: { id: true },
      });
      created.campaignId = campaign.id;

      // Seed a business/ad contact (ad_manager + reachable_tg) for the channel.
      const contact = await prisma.contact.create({
        data: {
          channelId: chosenChannelId,
          type: 'tg_username',
          value: '@ad_manager_example',
          rawValue: '@ad_manager_example',
          label: 'По рекламе',
          roleGuess: 'ad_manager',
          reachability: 'reachable_tg',
          status: 'new',
          tgUserId: `90000${Date.now().toString().slice(-6)}`,
        },
        select: { id: true },
      });
      created.contactIds.push(contact.id);

      // Refresh apps/api feature flags so the agency_sourcing gate sees enabled.
      const { getFeatureFlags } = await importApi('feature-flags.js');
      await getFeatureFlags().refresh();

      // Import the apps/api service (dynamic so env.ts validation defers to here).
      const { discoveryGuidedService } = await importApi('services/discovery-guided.js');

      // shortlist → launch.
      const shortlistRes = await discoveryGuidedService.candidateAction(run.id, chosen!.id, {
        action: 'shortlist',
      });
      expect(shortlistRes).toEqual({ ok: true });

      const launchRes = (await discoveryGuidedService.candidateAction(run.id, chosen!.id, {
        action: 'launch',
        campaignId: campaign.id,
      })) as {
        ok: true;
        added: number;
        suggestionsQueued: number;
        blocker: string | null;
      };
      // eslint-disable-next-line no-console
      console.log('\n=== PHASE 3 (launch-into-work) ===');
      // eslint-disable-next-line no-console
      console.log('launch result:', JSON.stringify(launchRes));

      expect(launchRes.added).toBeGreaterThanOrEqual(1);

      // A Conversation exists in manual mode (human-approval gate).
      const conv = await prisma.conversation.findFirst({
        where: { contactId: contact.id, campaignId: campaign.id },
        select: { id: true, mode: true },
      });
      expect(conv).toBeTruthy();
      created.conversationIds.push(conv!.id);
      expect(conv!.mode).toBe('manual');

      // An opener was queued (suggestionsQueued >= 1) — proves "запуск в работу".
      expect(launchRes.suggestionsQueued).toBeGreaterThanOrEqual(1);

      // The deterministic opener job IS enqueued on the agent-run queue with the
      // BullMQ-valid jobId `outreach_first_message-<convId>`. Proves the launch
      // prepared work for the operator (the opener job), not that nothing ran.
      const { getQueues } = await importApi('queues.js');
      const agentRunQueue = getQueues().agentRun as {
        getJob: (id: string) => Promise<{ data: unknown } | undefined>;
      };
      const openerJob = await agentRunQueue.getJob(`outreach_first_message-${conv!.id}`);
      expect(openerJob).toBeTruthy();
      // eslint-disable-next-line no-console
      console.log('opener job enqueued:', `outreach_first_message-${conv!.id}`);

      // ── DETERMINISTIC "no auto-send" proof (no LLM/API spend). ──
      // It is not enough that no out_ message exists (that only proves no worker
      // ran). We exercise the ACTUAL auto-approval guard the opener pipeline uses
      // (`tryAutoApprove`, apps/workers/src/services/auto-approve.ts) against the
      // launched conversation and assert it REFUSES because mode='manual'
      // (auto-approve.ts:127 → `return false` for manual/assisted). This is pure
      // DB + threshold logic — it makes NO LLM/OpenRouter/Yandex call, so the
      // test stays cheap. We feed it a real pending Suggestion (the opener worker
      // is not running here, so we synthesize the same shape it would post) and a
      // safety score above T_SAFETY so the ONLY thing that can refuse is the
      // manual-mode gate. A `false` return with the suggestion still `pending`
      // proves manual mode deterministically blocks auto-send.
      const { tryAutoApprove, T_SAFETY } = await import('../services/auto-approve.js');
      const probeSug = await prisma.suggestion.create({
        data: {
          conversationId: conv!.id,
          agentName: 'outreach_first_message',
          text: 'Здравствуйте! Пишем по поводу рекламного размещения — подскажите, пожалуйста, актуальный прайс и охваты.',
          rationale: 'e2e auto-approve guard probe',
          score: 1,
          status: 'pending',
        },
        select: { id: true },
      });
      const autoSent = await tryAutoApprove({
        conversationId: conv!.id,
        suggestionId: probeSug.id,
        text: 'probe',
        // Above T_SAFETY so safety never causes the refusal — the manual-mode
        // gate is the only thing that can (and must) block here.
        score: Math.min(1, T_SAFETY + 0.1),
        phase: 'first_touch',
      });
      // eslint-disable-next-line no-console
      console.log('tryAutoApprove(manual conversation) =>', autoSent, '(must be false)');
      expect(autoSent).toBe(false);

      // The guard must NOT have approved the suggestion (manual mode → pending).
      const probeAfter = await prisma.suggestion.findUniqueOrThrow({
        where: { id: probeSug.id },
        select: { status: true },
      });
      expect(probeAfter.status).toBe('pending');
      await prisma.suggestion.delete({ where: { id: probeSug.id } }).catch(() => {});

      // No outbound message was produced by the guard (belt-and-suspenders).
      const sentCount = await prisma.message.count({
        where: { conversationId: conv!.id, direction: 'out_' },
      });
      expect(sentCount).toBe(0);
      // eslint-disable-next-line no-console
      console.log('outbound/sent messages (must be 0):', sentCount);

      // No tg-send job exists for this conversation: the guard never enqueued a
      // send. We scan the tg-send queue's pending/active/delayed jobs for any
      // referencing this conversation.
      const tgSendQueue = getQueues().tgSend as {
        getJobs: (
          types: string[],
        ) => Promise<Array<{ data?: { conversationId?: string } }>>;
      };
      const tgJobs = await tgSendQueue.getJobs(['waiting', 'active', 'delayed', 'paused']);
      const tgForConv = tgJobs.filter((j) => j?.data?.conversationId === conv!.id);
      // eslint-disable-next-line no-console
      console.log('tg-send jobs for this conversation (must be 0):', tgForConv.length);
      expect(tgForConv.length).toBe(0);
    },
    180_000,
  );
});
