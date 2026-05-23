import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateUserInputZ, UserRoleZ } from '@nosquare/shared';
import { usersService } from '../services/users.js';

const UpdateUserInputZ = z.object({
  email: z.string().email().optional(),
  role: UserRoleZ.optional(),
  password: z.string().min(8).optional(),
});

export async function usersRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/users', { preHandler: [app.requireRole(['admin'])] }, async () =>
    usersService.list(),
  );

  app.post('/users', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const body = CreateUserInputZ.parse(req.body);
    return usersService.create(body);
  });

  app.patch('/users/:id', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = UpdateUserInputZ.parse(req.body);
    return usersService.update(params.id, body);
  });

  app.delete('/users/:id', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    await usersService.remove(params.id);
    return { ok: true };
  });
}
