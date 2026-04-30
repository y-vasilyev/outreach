import { getPrisma, encryptJson, decryptJson } from '@nosquare/db';
import { Errors } from '@nosquare/shared';

interface SCConfig {
  apiKey: string;
  baseUrl: string;
}

export const integrationsService = {
  async get(kind: string) {
    const prisma = getPrisma();
    return prisma.integration.findUnique({ where: { kind } });
  },

  async list() {
    const prisma = getPrisma();
    const items = await prisma.integration.findMany();
    return items.map((i) => ({
      id: i.id,
      kind: i.kind,
      enabled: i.enabled,
      status: i.status,
      lastCheckAt: i.lastCheckAt?.toISOString() ?? null,
    }));
  },

  async upsert(kind: string, payload: { apiKey: string; baseUrl?: string; enabled?: boolean }) {
    const prisma = getPrisma();
    const config: SCConfig = {
      apiKey: payload.apiKey,
      baseUrl: payload.baseUrl ?? 'https://api.scrapecreators.com',
    };
    const enc = await encryptJson(config);
    return prisma.integration.upsert({
      where: { kind },
      update: { configEncrypted: enc, enabled: payload.enabled ?? true },
      create: {
        kind,
        configEncrypted: enc,
        enabled: payload.enabled ?? true,
        status: 'configured',
      },
    });
  },

  async resolveScrapeCreators(): Promise<SCConfig | null> {
    const prisma = getPrisma();
    const i = await prisma.integration.findUnique({ where: { kind: 'scrapecreators' } });
    if (!i || !i.enabled) return null;
    return decryptJson<SCConfig>(i.configEncrypted);
  },

  async setStatus(kind: string, status: string) {
    const prisma = getPrisma();
    const i = await prisma.integration.findUnique({ where: { kind } });
    if (!i) throw Errors.notFound('integration', kind);
    return prisma.integration.update({
      where: { id: i.id },
      data: { status, lastCheckAt: new Date() },
    });
  },
};
