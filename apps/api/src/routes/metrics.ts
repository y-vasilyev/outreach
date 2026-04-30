import type { FastifyInstance } from 'fastify';
import { dashboardService } from '../services/dashboard.js';

export async function metricsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/metrics/dashboard', async () => {
    const [stats, byPlatform] = await Promise.all([
      dashboardService.stats(),
      dashboardService.byPlatform(),
    ]);
    return { stats, byPlatform };
  });
}
