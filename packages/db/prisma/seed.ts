import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { encryptJson } from '../src/crypto.js';
import { defaultAgentSeeds } from './agents.seed.js';
import { resolveCapabilityMap } from '@nosquare/shared';

// AJTBD scaffold for the demo campaign. Kept inline (no shared import)
// so this seed has no compile-time coupling to the shared zod schema —
// the migration's UPDATE statement uses the same shape.
const DEMO_AJTBD = {
  job: 'Провести 15-минутное CustDev-интервью с автором или менеджером канала про их рабочий процесс.',
  when: 'Когда канал получает входящие запросы от рекламодателей и автору нужно решать, с кем работать.',
  forces: {
    push: ['Автор устал от хаотичных переписок с брендами', 'Нет нормального портфолио для рекламодателей'],
    pull: ['Готовое автоматическое портфолио по каналу', 'Понимание, что бренды реально хотят'],
    anxieties: ['Это очередная продажа рекламы', 'Это отнимет много времени'],
    habits: ['Отвечает рекламодателям вручную в личке', 'Хранит примеры интеграций в Notion / голове'],
  },
  desired_outcome: 'Согласие на интервью + договорённость о времени.',
  non_goals: [
    'Продажа рекламы на канале',
    'Покупка размещения у автора',
    'Партнёрство / коллаборация',
    'Ценовое предложение',
  ],
};

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@nosquare.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin';
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash,
      role: 'admin',
    },
  });
  console.log(`✓ admin user: ${admin.email}`);

  // Default endpoints from env (if provided)
  const yandexKey = process.env.YANDEX_API_KEY;
  const yandexFolder = process.env.YANDEX_DEFAULT_FOLDER_ID;
  if (yandexKey && yandexFolder) {
    await prisma.endpoint.upsert({
      where: { name: 'yandex-default' },
      update: {},
      create: {
        name: 'yandex-default',
        provider: 'yandex',
        baseUrl: 'https://llm.api.cloud.yandex.net',
        authEncrypted: await encryptJson({ apiKey: yandexKey, folderId: yandexFolder }),
        defaultHeaders: {},
      },
    });
    console.log('✓ endpoint: yandex-default');
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    await prisma.endpoint.upsert({
      where: { name: 'openrouter-default' },
      update: {},
      create: {
        name: 'openrouter-default',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        authEncrypted: await encryptJson({ apiKey: openrouterKey }),
        defaultHeaders: {},
      },
    });
    console.log('✓ endpoint: openrouter-default');
  }

  // ScrapeCreators integration from env
  const scKey = process.env.SCRAPECREATORS_API_KEY;
  if (scKey) {
    await prisma.integration.upsert({
      where: { kind: 'scrapecreators' },
      update: {},
      create: {
        kind: 'scrapecreators',
        configEncrypted: await encryptJson({
          apiKey: scKey,
          baseUrl: process.env.SCRAPECREATORS_BASE_URL ?? 'https://api.scrapecreators.com',
        }),
        enabled: true,
        status: 'configured',
      },
    });
    console.log('✓ integration: scrapecreators');
  }

  // Resolve default endpoint ids if any. Agent seeds now use OpenRouter model ids,
  // so prefer an enabled OpenRouter endpoint when it is configured.
  const openrouterEndpoint = await prisma.endpoint.findFirst({
    where: { enabled: true, provider: 'openrouter' },
    orderBy: { createdAt: 'asc' },
  });
  const defaultEndpoint =
    openrouterEndpoint ??
    (await prisma.endpoint.findFirst({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    }));

  // Versioned upsert for agent configs:
  //   - new record  → insert with seed.version
  //   - existing AND db.version < seed.version → overwrite prompts + bump
  //   - existing AND db.version >= seed.version → leave alone (operator
  //     has likely edited via UI; UI bumps the version on save).
  // We never touch `enabled` (operator-controlled). Since agent seeds use
  // OpenRouter model ids, upgrading a seeded config also rebinds it to the
  // enabled OpenRouter endpoint when one exists.
  for (const seed of defaultAgentSeeds) {
    const existing = await prisma.agentConfig.findUnique({
      where: { name: seed.name },
      select: { version: true },
    });
    if (!existing) {
      await prisma.agentConfig.create({
        data: {
          name: seed.name,
          role: seed.role,
          description: seed.description,
          endpointId: defaultEndpoint?.id ?? null,
          model: seed.model,
          systemPrompt: seed.systemPrompt,
          userPromptTemplate: seed.userPromptTemplate,
          params: seed.params as object,
          enabled: true,
          version: seed.version,
        },
      });
      console.log(`✓ agent_config: ${seed.name} (created v${seed.version})`);
    } else if (existing.version < seed.version) {
      await prisma.agentConfig.update({
        where: { name: seed.name },
        data: {
          role: seed.role,
          description: seed.description,
          ...(openrouterEndpoint ? { endpointId: openrouterEndpoint.id } : {}),
          model: seed.model,
          systemPrompt: seed.systemPrompt,
          userPromptTemplate: seed.userPromptTemplate,
          params: seed.params as object,
          version: seed.version,
        },
      });
      console.log(
        `✓ agent_config: ${seed.name} (upgraded v${existing.version} → v${seed.version})`,
      );
    } else {
      console.log(
        `· agent_config: ${seed.name} (kept v${existing.version}, seed v${seed.version})`,
      );
    }
  }

  // Campaign-type registry (agency-sourcing-matching change). Idempotent
  // upsert of the two built-in types. `update` re-syncs the config so seed
  // changes propagate to dev/CI; operator-authored types are untouched
  // (different keys). Pipelines read safetyProfile / autonomyPolicy from
  // here behind ENABLE_CAMPAIGN_TYPES.
  const BASE_AGENT_SET = {
    opening_composer: { agentName: 'opening_composer', overrides: {} },
    approach_strategist: { agentName: 'approach_strategist', overrides: {} },
    reply_composer: { agentName: 'reply_composer', overrides: {} },
    intent_classifier: { agentName: 'intent_classifier', overrides: {} },
    safety_filter: { agentName: 'safety_filter', overrides: {} },
    handoff_decider: { agentName: 'handoff_decider', overrides: {} },
    goal_fit_evaluator: { agentName: 'goal_fit_evaluator', overrides: {} },
    conversation_summarizer: { agentName: 'conversation_summarizer', overrides: {} },
    next_action_planner: { agentName: 'next_action_planner', overrides: {} },
  };

  const campaignTypeSeeds = [
    {
      key: 'custdev',
      name: 'CustDev интервью',
      description:
        'Приглашение на исследовательское интервью по продукту. Не продажа, не реклама.',
      goalSchema: {
        type: 'object',
        required: ['job', 'desired_outcome'],
        properties: {
          job: { type: 'string' },
          when: { type: 'string' },
          forces: { type: 'object' },
          desired_outcome: { type: 'string' },
          non_goals: { type: 'array', items: { type: 'string' } },
        },
      },
      agentSet: BASE_AGENT_SET,
      // Mirrors the legacy SafetyFilter intent: ad-sales lexicon raises the
      // risk score (advisory), 600-char cap, no links in turn one.
      safetyProfile: {
        forbidden_topics: [
          'реклама',
          'рекламная',
          'интеграц',
          'купить рекламу',
          'разместить',
          'промо',
          'приобрести',
          'оффер',
          'выгодное предложение',
        ],
        allowed_topics: [],
        allow_links: false,
        max_length: 600,
      },
      // Empty: CustDev escalations (hostile / spam / request_human /
      // wants_payment_for_ads / wants_to_schedule) already live in
      // HandoffDecider's deterministic rules. Keeping this empty preserves
      // exact pre-registry behavior.
      autonomyPolicy: {
        defaultMode: 'assisted',
        T_safety: 0.8,
        T_semi_auto_goalfit: 0.6,
        T_auto_goalfit: 0.75,
        forceHandoffIntents: [],
      },
    },
    {
      key: 'agency_sourcing',
      name: 'Агентство по размещению рекламы',
      description:
        'Заход от лица агентства: сбор прайсов, форматов, сроков, охватов и статистики аудитории для базы блогеров.',
      goalSchema: {
        type: 'object',
        required: ['target_data_points'],
        properties: {
          target_data_points: { type: 'array', items: { type: 'string' } },
          client_brief: { type: 'string' },
        },
      },
      agentSet: BASE_AGENT_SET,
      // Inverse of CustDev: commercial vocabulary is on-goal here, so it must
      // NOT raise the risk score. M4 adds the agency-specific agents/prompts.
      safetyProfile: {
        forbidden_topics: [],
        allowed_topics: ['реклама', 'интеграция', 'прайс', 'охваты', 'формат', 'размещение'],
        allow_links: false,
        max_length: 800,
      },
      // Price/quote intents (added to IntentClassifier in M4) force a human
      // to confirm commercial terms.
      autonomyPolicy: {
        defaultMode: 'assisted',
        T_safety: 0.8,
        T_semi_auto_goalfit: 0.6,
        T_auto_goalfit: 0.75,
        forceHandoffIntents: ['discusses_price', 'sends_quote', 'wants_payment_for_ads'],
      },
    },
  ] as const;

  for (const t of campaignTypeSeeds) {
    await prisma.campaignType.upsert({
      where: { key: t.key },
      update: {
        name: t.name,
        description: t.description,
        goalSchema: t.goalSchema as object,
        agentSet: t.agentSet as object,
        safetyProfile: t.safetyProfile as object,
        autonomyPolicy: t.autonomyPolicy as object,
        builtIn: true,
      },
      create: {
        id: t.key,
        key: t.key,
        name: t.name,
        description: t.description,
        goalSchema: t.goalSchema as object,
        agentSet: t.agentSet as object,
        safetyProfile: t.safetyProfile as object,
        autonomyPolicy: t.autonomyPolicy as object,
        builtIn: true,
        enabled: true,
      },
    });
    console.log(`✓ campaign_type: ${t.key}`);
  }

  // Capability → endpoint/model map (agency-sourcing-matching M3, task 3.1).
  // The builder picks a tier (cheap/medium/strong) per role and binds it to
  // an enabled endpoint of the matching provider. We resolve it here against
  // the endpoints actually configured so the seed log surfaces which tiers
  // are usable in this deployment — and which degrade (no endpoint).
  const allEndpoints = await prisma.endpoint.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, provider: true, enabled: true, name: true },
  });
  const resolvedMap = resolveCapabilityMap(
    allEndpoints.map((e) => ({ id: e.id, provider: e.provider, enabled: e.enabled })),
  );
  for (const tier of ['cheap', 'medium', 'strong'] as const) {
    const r = resolvedMap[tier];
    if (r.available) {
      const ep = allEndpoints.find((e) => e.id === r.endpointId);
      console.log(
        `✓ capability_map: ${tier} → ${ep?.name ?? r.endpointId} (${r.provider} / ${r.model})`,
      );
    } else {
      console.log(
        `· capability_map: ${tier} → (no endpoint configured — builder will report this tier as unavailable)`,
      );
    }
  }

  // Optional demo campaign seed. Off by default so prod / CI seeds
  // don't pollute the campaigns table. Set SEED_DEMO_CAMPAIGN=1 in dev
  // to make a sample campaign with populated AJTBD and defaultMode =
  // semi_auto (so new conversations under it inherit semi-auto and
  // the GoalFitEvaluator gate exercises the auto-approve path).
  if (process.env.SEED_DEMO_CAMPAIGN === '1') {
    const demo = await prisma.campaign.upsert({
      where: { id: 'demo-custdev' },
      update: {
        ajtbd: DEMO_AJTBD,
        defaultMode: 'semi_auto',
      },
      create: {
        id: 'demo-custdev',
        name: 'Demo CustDev',
        goalText: DEMO_AJTBD.job,
        valueProp: DEMO_AJTBD.desired_outcome,
        ajtbd: DEMO_AJTBD,
        defaultMode: 'semi_auto',
        status: 'draft',
        createdById: admin.id,
      },
    });
    console.log(`✓ campaign: ${demo.name} (defaultMode=semi_auto, AJTBD populated)`);
  }

  console.log('\nSeed complete.');
  console.log(`Admin: ${adminEmail} / ${adminPassword}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
