import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateCampaignInputZ } from '@nosquare/shared';
import { campaignsService } from '../services/campaigns.js';

export async function campaignsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/campaigns', async () => campaignsService.list());

  app.get('/campaigns/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return campaignsService.get(params.id);
  });

  app.post('/campaigns', async (req) => {
    const body = CreateCampaignInputZ.parse(req.body);
    return campaignsService.create(body, (req.user as { id: string }).id);
  });

  app.patch('/campaigns/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const patch = CreateCampaignInputZ.partial().parse(req.body);
    return campaignsService.update(params.id, patch);
  });

  app.post('/campaigns/:id/run', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return campaignsService.setStatus(params.id, 'running');
  });

  app.post('/campaigns/:id/pause', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return campaignsService.setStatus(params.id, 'paused');
  });

  app.post('/campaigns/:id/preview', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ limit: z.number().int().min(1).max(20).default(5) })
      .parse(req.body ?? {});
    return campaignsService.preview(params.id, body.limit);
  });
}
