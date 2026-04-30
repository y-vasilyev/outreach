import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ImportChannelsInputZ, ChannelFiltersZ } from '@nosquare/shared';
import { channelsService } from '../services/channels.js';

export async function channelsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/channels', async (req) => {
    const q = ChannelFiltersZ.parse(req.query);
    return channelsService.list(q);
  });

  app.get('/channels/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return channelsService.get(params.id);
  });

  app.post('/channels/import', async (req) => {
    const body = ImportChannelsInputZ.parse(req.body);
    return channelsService.import({ ...body, addedById: req.user.id });
  });

  app.post('/channels/:id/scrape', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return channelsService.rescrape(params.id);
  });
}
