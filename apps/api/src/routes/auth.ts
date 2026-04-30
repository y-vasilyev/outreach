import type { FastifyInstance } from 'fastify';
import { LoginInputZ } from '@nosquare/shared';
import { usersService } from '../services/users.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req) => {
    const body = LoginInputZ.parse(req.body);
    const user = await usersService.authenticate(body.email, body.password);
    const token = await app.jwt.sign(user, { expiresIn: '7d' });
    return { token, user };
  });

  app.get(
    '/auth/me',
    { onRequest: [app.authenticate] },
    async (req) => {
      return { user: req.user };
    },
  );
}
