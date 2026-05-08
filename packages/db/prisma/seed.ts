import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { encryptJson } from '../src/crypto.js';
import { defaultAgentSeeds } from './agents.seed.js';

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
