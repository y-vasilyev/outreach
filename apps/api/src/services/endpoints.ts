import { getPrisma, encryptJson, decryptJson } from '@nosquare/db';
import type { CreateEndpointInputZ } from '@nosquare/shared';
import { z } from 'zod';
import { Errors } from '@nosquare/shared';
import { createProvider, type ModelInfo } from '@nosquare/llm';

type CreateInput = z.infer<typeof CreateEndpointInputZ>;

interface AuthEnvelope {
  apiKey?: string;
  folderId?: string;
  iamToken?: string;
}

export const endpointsService = {
  async list() {
    const prisma = getPrisma();
    const items = await prisma.endpoint.findMany({ orderBy: { createdAt: 'desc' } });
    return items.map((e) => ({
      id: e.id,
      name: e.name,
      provider: e.provider,
      baseUrl: e.baseUrl,
      defaultHeaders: e.defaultHeaders as Record<string, string>,
      rateLimitRpm: e.rateLimitRpm,
      enabled: e.enabled,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    }));
  },

  async create(input: CreateInput) {
    const prisma = getPrisma();
    const auth: AuthEnvelope = {
      apiKey: input.apiKey,
      folderId: input.folderId,
      iamToken: input.iamToken,
    };
    const encrypted = await encryptJson(auth);
    return prisma.endpoint.create({
      data: {
        name: input.name,
        provider: input.provider,
        baseUrl: input.baseUrl,
        authEncrypted: encrypted,
        defaultHeaders: input.defaultHeaders ?? {},
        rateLimitRpm: input.rateLimitRpm ?? null,
        enabled: input.enabled ?? true,
      },
    });
  },

  async update(id: string, patch: Partial<CreateInput>) {
    const prisma = getPrisma();
    const cur = await prisma.endpoint.findUnique({ where: { id } });
    if (!cur) throw Errors.notFound('endpoint', id);

    let authEncrypted = cur.authEncrypted;
    if (patch.apiKey || patch.folderId || patch.iamToken) {
      const auth = (await decryptJson<AuthEnvelope>(cur.authEncrypted)) ?? {};
      if (patch.apiKey) auth.apiKey = patch.apiKey;
      if (patch.folderId) auth.folderId = patch.folderId;
      if (patch.iamToken) auth.iamToken = patch.iamToken;
      authEncrypted = await encryptJson(auth);
    }

    return prisma.endpoint.update({
      where: { id },
      data: {
        name: patch.name ?? cur.name,
        provider: patch.provider ?? cur.provider,
        baseUrl: patch.baseUrl ?? cur.baseUrl,
        authEncrypted,
        defaultHeaders: patch.defaultHeaders ?? (cur.defaultHeaders as Record<string, string>),
        rateLimitRpm: patch.rateLimitRpm ?? cur.rateLimitRpm,
        enabled: patch.enabled ?? cur.enabled,
      },
    });
  },

  async delete(id: string) {
    const prisma = getPrisma();
    await prisma.endpoint.delete({ where: { id } });
  },

  async resolve(endpointId: string) {
    const prisma = getPrisma();
    const ep = await prisma.endpoint.findUnique({ where: { id: endpointId } });
    if (!ep) throw Errors.notFound('endpoint', endpointId);
    const auth = await decryptJson<AuthEnvelope>(ep.authEncrypted);
    return {
      id: ep.id,
      provider: ep.provider as 'yandex' | 'openrouter' | 'openai_compat',
      baseUrl: ep.baseUrl,
      apiKey: auth.apiKey ?? '',
      folderId: auth.folderId,
      iamToken: auth.iamToken,
      defaultHeaders: ep.defaultHeaders as Record<string, string>,
    };
  },

  async listModels(endpointId: string): Promise<ModelInfo[]> {
    const resolved = await this.resolve(endpointId);
    const provider = createProvider(resolved.provider, {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      folderId: resolved.folderId,
      iamToken: resolved.iamToken,
      defaultHeaders: resolved.defaultHeaders,
      // Models endpoint shouldn't take long; cap to 15s so a dead provider
      // doesn't block the UI.
      timeoutMs: 15_000,
    });
    return provider.listModels();
  },
};
