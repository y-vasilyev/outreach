import { getPrisma } from '@nosquare/db';
import bcrypt from 'bcryptjs';
import { Errors } from '@nosquare/shared';

export const usersService = {
  async list() {
    const prisma = getPrisma();
    return prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, role: true, createdAt: true, updatedAt: true },
    });
  },

  async create(input: { email: string; password: string; role: 'admin' | 'operator' | 'viewer' }) {
    const prisma = getPrisma();
    const passwordHash = await bcrypt.hash(input.password, 10);
    return prisma.user.create({
      data: { email: input.email, passwordHash, role: input.role },
      select: { id: true, email: true, role: true, createdAt: true, updatedAt: true },
    });
  },

  async authenticate(email: string, password: string) {
    const prisma = getPrisma();
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u) throw Errors.unauthorized('Invalid credentials');
    const ok = await bcrypt.compare(password, u.passwordHash);
    if (!ok) throw Errors.unauthorized('Invalid credentials');
    return { id: u.id, email: u.email, role: u.role };
  },
};
