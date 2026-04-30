import type { FastifyInstance } from 'fastify';
import { CreateUserInputZ } from '@nosquare/shared';
import { usersService } from '../services/users.js';

export async function usersRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/users', { preHandler: [app.requireRole(['admin'])] }, async () =>
    usersService.list(),
  );

  app.post('/users', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const body = CreateUserInputZ.parse(req.body);
    return usersService.create(body);
  });
}
