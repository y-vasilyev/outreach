import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateEndpointInputZ } from '@nosquare/shared';
import { endpointsService } from '../services/endpoints.js';

export async function endpointsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/endpoints', { preHandler: [app.requireRole(['admin'])] }, async () => endpointsService.list());

  app.post('/endpoints', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const body = CreateEndpointInputZ.parse(req.body);
    return endpointsService.create(body);
  });

  app.patch('/endpoints/:id', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const patch = CreateEndpointInputZ.partial().parse(req.body);
    return endpointsService.update(params.id, patch);
  });

  app.delete('/endpoints/:id', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    await endpointsService.delete(params.id);
    return { ok: true };
  });

  app.post('/endpoints/:id/test', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const started = Date.now();
    try {
      await endpointsService.resolve(params.id);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.get('/endpoints/:id/models', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return endpointsService.listModels(params.id);
  });
}
