import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  tgAccount: {
    updateMany: vi.fn(),
  },
};

vi.mock('@nosquare/db', () => ({
  getPrisma: () => prismaMock,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { healExpiredCooldownAccounts } from '../services/cooldown-healer.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('healExpiredCooldownAccounts', () => {
  it('moves expired cooldown accounts back to active for outreach selection', async () => {
    prismaMock.tgAccount.updateMany.mockResolvedValue({ count: 2 });

    await expect(healExpiredCooldownAccounts()).resolves.toBe(2);

    expect(prismaMock.tgAccount.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'cooldown',
        OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: expect.any(Date) } }],
      },
      data: { status: 'active' },
    });
  });
});
