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
  /**
   * Outbound proxy URL. Stored encrypted alongside the API key because
   * many proxies embed credentials (`http://user:pass@host:port`).
   */
  proxyUrl?: string;
}

export const endpointsService = {
  async list() {
    const prisma = getPrisma();
    const items = await prisma.endpoint.findMany({ orderBy: { createdAt: 'desc' } });
    // We surface only a boolean flag for proxy presence — never the URL
    // itself, since it can carry credentials.
    return Promise.all(
      items.map(async (e) => {
        let hasProxy = false;
        try {
          const auth = await decryptJson<AuthEnvelope>(e.authEncrypted);
          hasProxy = !!auth?.proxyUrl;
        } catch {
          /* ignore — list view should never fail on a single bad row */
        }
        return {
          id: e.id,
          name: e.name,
          provider: e.provider,
          baseUrl: e.baseUrl,
          defaultHeaders: e.defaultHeaders as Record<string, string>,
          rateLimitRpm: e.rateLimitRpm,
          enabled: e.enabled,
          hasProxy,
          createdAt: e.createdAt.toISOString(),
          updatedAt: e.updatedAt.toISOString(),
        };
      }),
    );
  },

  async create(input: CreateInput) {
    const prisma = getPrisma();
    const auth: AuthEnvelope = {
      apiKey: input.apiKey,
      folderId: input.folderId,
      iamToken: input.iamToken,
      proxyUrl: input.proxyUrl,
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

  async update(id: string, patch: Partial<CreateInput> & { proxyUrl?: string | null }) {
    const prisma = getPrisma();
    const cur = await prisma.endpoint.findUnique({ where: { id } });
    if (!cur) throw Errors.notFound('endpoint', id);

    let authEncrypted = cur.authEncrypted;
    // Re-encrypt when ANY auth field changed, including clearing proxyUrl.
    // We treat `proxyUrl: ""` (or null) as "remove" so the operator can
    // turn proxying off via the same form.
    const hasAuthPatch =
      patch.apiKey !== undefined ||
      patch.folderId !== undefined ||
      patch.iamToken !== undefined ||
      patch.proxyUrl !== undefined;
    if (hasAuthPatch) {
      const auth = (await decryptJson<AuthEnvelope>(cur.authEncrypted)) ?? {};
      if (patch.apiKey) auth.apiKey = patch.apiKey;
      if (patch.folderId) auth.folderId = patch.folderId;
      if (patch.iamToken) auth.iamToken = patch.iamToken;
      if (patch.proxyUrl !== undefined) {
        if (patch.proxyUrl) auth.proxyUrl = patch.proxyUrl;
        else delete auth.proxyUrl;
      }
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
      proxyUrl: auth.proxyUrl,
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
      proxyUrl: resolved.proxyUrl,
      defaultHeaders: resolved.defaultHeaders,
      // Models endpoint shouldn't take long; cap to 15s so a dead provider
      // doesn't block the UI.
      timeoutMs: 15_000,
    });
    return provider.listModels();
  },
};
