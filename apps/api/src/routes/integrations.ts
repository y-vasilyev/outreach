import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UpsertIntegrationInputZ, Errors } from '@nosquare/shared';
import { integrationsService } from '../services/integrations.js';

export async function integrationsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/integrations', async () => integrationsService.list());

  app.get('/integrations/:kind', async (req) => {
    const params = z.object({ kind: z.string() }).parse(req.params);
    const i = await integrationsService.get(params.kind);
    if (!i) throw Errors.notFound('integration', params.kind);
    return {
      id: i.id,
      kind: i.kind,
      enabled: i.enabled,
      status: i.status,
      lastCheckAt: i.lastCheckAt?.toISOString() ?? null,
    };
  });

  app.put('/integrations/:kind', async (req) => {
    const params = z.object({ kind: z.string() }).parse(req.params);
    const body = UpsertIntegrationInputZ.parse({ kind: params.kind, ...(req.body as object) });
    const i = await integrationsService.upsert(params.kind, {
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      enabled: body.enabled,
    });
    return {
      id: i.id,
      kind: i.kind,
      enabled: i.enabled,
      status: i.status,
      lastCheckAt: i.lastCheckAt?.toISOString() ?? null,
    };
  });

  app.post('/integrations/:kind/test', async (req) => {
    const params = z.object({ kind: z.string() }).parse(req.params);
    const started = Date.now();
    if (params.kind === 'scrapecreators') {
      const cfg = await integrationsService.resolveScrapeCreators();
      if (!cfg) {
        await integrationsService.setStatus(params.kind, 'error');
        return { ok: false, error: 'integration_not_configured' };
      }
      await integrationsService.setStatus(params.kind, 'ok');
      return { ok: true, latencyMs: Date.now() - started };
    }
    await integrationsService.setStatus(params.kind, 'unknown');
    return { ok: false, error: 'unsupported_integration' };
  });
}
