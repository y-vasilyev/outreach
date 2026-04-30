import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { encryptJson } from '../src/crypto.js';
import { defaultAgentSeeds } from './agents.seed.js';

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

  // Resolve default endpoint ids if any
  const defaultEndpoint = await prisma.endpoint.findFirst({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const seed of defaultAgentSeeds) {
    await prisma.agentConfig.upsert({
      where: { name: seed.name },
      update: {},
      create: {
        name: seed.name,
        role: seed.role,
        description: seed.description,
        endpointId: defaultEndpoint?.id ?? null,
        model: seed.model,
        systemPrompt: seed.systemPrompt,
        userPromptTemplate: seed.userPromptTemplate,
        params: seed.params as object,
        enabled: true,
        version: 1,
      },
    });
    console.log(`✓ agent_config: ${seed.name}`);
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
