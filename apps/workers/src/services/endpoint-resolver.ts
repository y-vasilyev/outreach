import { getPrisma, decryptJson } from '@nosquare/db';
import { Errors } from '@nosquare/shared';

interface AuthEnvelope {
  apiKey?: string;
  folderId?: string;
  iamToken?: string;
  /**
   * Outbound proxy URL. Stored encrypted alongside the API key because
   * many proxies embed credentials. Forwarded into ProviderConfig.proxyUrl
   * so undici routes the LLM fetch() through it. Without this the
   * worker's agent calls bypassed the configured proxy entirely.
   */
  proxyUrl?: string;
}

export async function resolveEndpoint(endpointId: string | null) {
  if (!endpointId) throw Errors.badRequest('agent has no endpoint configured');
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
}
