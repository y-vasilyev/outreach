import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { encryptJson } from '../src/crypto.js';
import { defaultAgentSeeds } from './agents.seed.js';
import { resolveCapabilityMap, FEATURE_FLAG_KEYS, FEATURE_FLAG_DEFAULTS } from '@nosquare/shared';

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

  // Yandex Search integration from env (channel-discovery-search). Encrypted;
  // the discovery service decrypts it at use time. Search API key is separate
  // from the LLM key (different Search-API role).
  const yandexSearchKey = process.env.YANDEX_SEARCH_API_KEY;
  const yandexSearchFolder = process.env.YANDEX_SEARCH_FOLDER_ID ?? process.env.YANDEX_DEFAULT_FOLDER_ID;
  if (yandexSearchKey && yandexSearchFolder) {
    await prisma.integration.upsert({
      where: { kind: 'yandex_search' },
      update: {},
      create: {
        kind: 'yandex_search',
        configEncrypted: await encryptJson({ apiKey: yandexSearchKey, folderId: yandexSearchFolder }),
        enabled: true,
        status: 'configured',
      },
    });
    console.log('✓ integration: yandex_search');
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

  // Bind any agent that still has no endpoint to the default endpoint
  // (e.g. configs created on an earlier seed run before any endpoint was
  // configured — the versioned upsert above only rebinds on a version bump).
  // Idempotent: only fills nulls, never overrides an operator's choice. Prefers
  // the OpenRouter endpoint since the built-in agent models are OpenRouter ids.
  if (defaultEndpoint) {
    const bound = await prisma.agentConfig.updateMany({
      where: { endpointId: null },
      data: { endpointId: defaultEndpoint.id },
    });
    if (bound.count > 0) {
      const epName = defaultEndpoint.id === openrouterEndpoint?.id ? 'openrouter-default' : 'default endpoint';
      console.log(`✓ bound ${bound.count} unbound agent_config(s) → ${epName}`);
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

  // Agency-sourcing agent set (agency-sourcing-matching M4, task 4.5): reuse
  // the shared classifier/safety/handoff/summarizer agents but point the
  // `opening_composer` role at the agency-framed composer and add the
  // data-collection planner role. The worker resolves a role→agent via
  // `resolveAgentName(agentSet, role, fallback)` (packages/shared) behind
  // ENABLE_CAMPAIGN_TYPES; that call-site wiring lands with the agency inbound
  // pipeline (M4 worker integration) — the registry already carries the map.
  const AGENCY_AGENT_SET = {
    ...BASE_AGENT_SET,
    opening_composer: { agentName: 'agency_opening_composer', overrides: {} },
    data_collection_planner: { agentName: 'data_collection_planner', overrides: {} },
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
      // risk score (advisory), 600-char cap, no links in turn one. No
      // hard-block patterns — CustDev keeps the legacy advisory behavior.
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
        hard_block_patterns: [],
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
      agentSet: AGENCY_AGENT_SET,
      // Inverse of CustDev (D7). Commercial vocabulary is ON-goal here, so it
      // is `allowed_topics` (never raises the risk score). `forbidden_topics`
      // are NOT a salesy-lexicon list — they are advisory tone signals for the
      // SafetyFilter LLM that capture the agency-specific guardrails:
      //   - result guarantees (гарантируем результат / гарантия продаж/охватов)
      //   - fabricated client specifics (выдуманный бренд/бюджет клиента)
      //   - money transfers / payment links before operator confirmation
      //   - pressure tactics (срочно/только сегодня/последнее место)
      // Hard guards (max_length, links) still apply deterministically.
      safetyProfile: {
        forbidden_topics: [
          'гарантируем результат',
          'гарантия продаж',
          'гарантированный охват',
          'гарантируем продажи',
          'оплатите по ссылке',
          'переведите предоплату',
          'реквизиты для оплаты',
          'только сегодня',
          'последнее место',
          'срочно решайте',
        ],
        allowed_topics: ['реклама', 'интеграция', 'прайс', 'охваты', 'формат', 'размещение'],
        allow_links: false,
        max_length: 800,
        // safety-filter-hard-block: deterministic regexes that REJECT the
        // variant before LLM scoring. These cover the safety-critical
        // categories that the agency promo composer's prompt forbids but
        // a small/hot LLM might still emit. `id` is logged for ops.
        hard_block_patterns: [
          // Split into multiple smaller rules — keeps each `pattern`
          // under HardBlockPatternZ.pattern's 200-char cap and gives each
          // category its own stable id for ops triage.
          {
            id: 'agency_guarantee_verb',
            // "гарантирую/гарантируем продажи / охват / подписчиков ..."
            pattern:
              '(гарантиру[а-я]+|гаранти[яи])\\s+(результат|охват|продаж|подписч|пр[оие]смотр|кликов|конверс|трафик)',
            reason: 'обещание гарантированного результата (verbal/noun form)',
            flags: 'iu',
          },
          {
            id: 'agency_guarantee_adjective',
            // "гарантированный охват / гарантированные продажи / ..."
            pattern:
              'гарантированн[а-я]+\\s+(результат|охват|продаж|подписч|пр[оие]смотр|кликов|конверс|трафик)',
            reason: 'обещание гарантированного результата (adjective form)',
            flags: 'iu',
          },
          {
            id: 'agency_guarantee_numeric',
            // "+1000 подписчиков / +500 просмотров / +1500 sales ..."
            pattern: '\\+\\s*\\d+\\s*(подписчик|охват|view|sale|просмотр|click|конверс)',
            reason: 'обещание гарантированного числового результата',
            flags: 'iu',
          },
          {
            id: 'agency_guarantee_en',
            // "guarantee result / reach / sale / view / click / conversion"
            pattern:
              'guarantee[a-z]*\\s+(result|reach|sale|view|click|conversion)',
            reason: 'guarantee of a specific commercial result (en)',
            flags: 'iu',
          },
          {
            id: 'agency_time_pressure',
            // "только сегодня / осталось N мест / последнее место / срочно
            // решай". Non-capturing alternation for the «последнее|последние»
            // case so the «-ее» (n.sg.) / «-ие» (pl.) variants both match.
            // Use a Cyrillic-safe end delimiter via lookahead instead of
            // `\\b` — JS `\\b` is ASCII-only even with the `u` flag and
            // therefore wouldn't stop a Cyrillic-prefix false match like
            // "последняя местная".
            pattern:
              '(только\\s+сегодня|осталось\\s+(\\d+|несколько|последн[а-я]+)\\s+мест[оа]?(?=$|\\s|[.,!?;:])|срочно\\s+решай|последн(?:ее|ие|яя)\\s+мест[оа]?(?=$|\\s|[.,!?;:]))',
            reason: 'временное давление / scarcity tactics',
            flags: 'iu',
          },
          {
            id: 'agency_payment_mention',
            // payment / wire / bank-card mentions before operator approval
            pattern:
              '(перевед[а-я]+\\s+(на|по|сразу)|оплат[а-я]+\\s+(по\\s+ссылк|на\\s+карт|сейчас|сразу)|реквизит[а-я]+|номер\\s+карт[а-я]+|банковск[а-я]+\\s+карт)',
            reason: 'упоминание оплаты/перевода до подтверждения оператором',
            flags: 'iu',
          },
        ],
      },
      // Agency dialogues default to `assisted` (D7 + non-goal: no auto price
      // negotiation): the AI drafts, a human confirms before sending. Price/
      // quote intents (discusses_price / sends_quote, added to IntentClassifier
      // in M4) plus wants_payment_for_ads force an immediate operator handoff
      // so a human confirms commercial terms before any price is agreed.
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

  // Feature flags (runtime-feature-flags change). Keys + defaults are derived
  // from the shared registry (single source of truth — no drift). Idempotent:
  // create missing rows at their registry default; NEVER overwrite an
  // operator's toggle (only the label is refreshed on re-seed).
  const FLAG_DESCRIPTIONS: Record<string, string> = {
    campaign_types: 'Реестр типов кампаний + конструктор',
    agency_sourcing: 'Агентский режим: сбор прайсов/охватов у блогеров',
    object_storage: 'Хранение медиа/сырья в S3 (нужен S3_*)',
    blogger_matching: 'Подбор блогеров под бриф',
    channel_discovery: 'Дискавери каналов по нише через Yandex Search',
  };
  for (const key of FEATURE_FLAG_KEYS) {
    const description = FLAG_DESCRIPTIONS[key] ?? '';
    await prisma.featureFlag.upsert({
      where: { key },
      update: { description },
      create: { key, enabled: FEATURE_FLAG_DEFAULTS[key], description },
    });
  }
  console.log(`✓ feature_flag: ${FEATURE_FLAG_KEYS.length} flags ensured`);

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
  // to make a sample campaign with populated goal (AJTBD shape for the
  // custdev type) and defaultMode = semi_auto (so new conversations
  // under it inherit semi-auto and the GoalFitEvaluator gate exercises
  // the auto-approve path).
  if (process.env.SEED_DEMO_CAMPAIGN === '1') {
    const demo = await prisma.campaign.upsert({
      where: { id: 'demo-custdev' },
      update: {
        goal: DEMO_AJTBD,
        defaultMode: 'semi_auto',
      },
      create: {
        id: 'demo-custdev',
        name: 'Demo CustDev',
        goalText: DEMO_AJTBD.job,
        valueProp: DEMO_AJTBD.desired_outcome,
        // typeId is required as of migration 7. `goal` carries the
        // AJTBD shape for the custdev type. The legacy `Campaign.ajtbd`
        // column was removed by `drop-campaign-ajtbd-column`.
        typeId: 'custdev',
        goal: DEMO_AJTBD,
        defaultMode: 'semi_auto',
        status: 'draft',
        createdById: admin.id,
      },
    });
    console.log(`✓ campaign: ${demo.name} (defaultMode=semi_auto, goal populated)`);
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
