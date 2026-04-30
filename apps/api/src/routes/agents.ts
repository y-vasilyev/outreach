import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UpdateAgentConfigInputZ, TestAgentInputZ } from '@nosquare/shared';
import { agentsService } from '../services/agents.js';

export async function agentsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/agents', async () => agentsService.list());

  app.get('/agents/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return agentsService.get(params.id);
  });

  app.patch('/agents/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const patch = UpdateAgentConfigInputZ.parse({ id: params.id, ...(req.body as object) });
    return agentsService.update(params.id, patch, (req.user as { id: string }).id);
  });

  app.post('/agents/:id/test', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = TestAgentInputZ.parse({ id: params.id, ...(req.body as object) });
    return agentsService.test(params.id, body.input);
  });

  app.get('/agents/:id/history', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return agentsService.history(params.id);
  });
}
