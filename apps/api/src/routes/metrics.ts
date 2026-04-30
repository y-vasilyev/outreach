import type { FastifyInstance } from 'fastify';
import { dashboardService } from '../services/dashboard.js';

export async function metricsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/metrics/dashboard', async () => dashboardService.stats());
}
