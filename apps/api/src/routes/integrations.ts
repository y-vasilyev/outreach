import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UpsertIntegrationInputZ } from '@nosquare/shared';
import { integrationsService } from '../services/integrations.js';

export async function integrationsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/integrations', async () => integrationsService.list());

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
}
