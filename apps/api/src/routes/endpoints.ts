import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateEndpointInputZ } from '@nosquare/shared';
import { endpointsService } from '../services/endpoints.js';

export async function endpointsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/endpoints', async () => endpointsService.list());

  app.post('/endpoints', async (req) => {
    const body = CreateEndpointInputZ.parse(req.body);
    return endpointsService.create(body);
  });

  app.patch('/endpoints/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const patch = CreateEndpointInputZ.partial().parse(req.body);
    return endpointsService.update(params.id, patch);
  });

  app.delete('/endpoints/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    await endpointsService.delete(params.id);
    return { ok: true };
  });
}
