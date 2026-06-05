import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  tgAccount: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('@nosquare/db', () => ({
  getPrisma: () => prismaMock,
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code = 'P2025';
    },
  },
}));

import { tgAccountsService } from '../tg-accounts.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tgAccountsService.clearCooldown', () => {
  it('returns a cleared cooldown account to active so outreach pickers can use it', async () => {
    prismaMock.tgAccount.findUnique.mockResolvedValue({ id: 'acct1' });
    prismaMock.tgAccount.update.mockResolvedValue({
      id: 'acct1',
      status: 'active',
      cooldownUntil: null,
    });

    await tgAccountsService.clearCooldown('acct1');

    expect(prismaMock.tgAccount.update).toHaveBeenCalledWith({
      where: { id: 'acct1' },
      data: { status: 'active', cooldownUntil: null },
    });
  });
});
