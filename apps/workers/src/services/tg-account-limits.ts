import { getPrisma } from '@nosquare/db';

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export async function rolloverTgAccountDailyCounters(ids?: string[]): Promise<void> {
  const prisma = getPrisma();
  const now = new Date();
  const rows = await prisma.tgAccount.findMany({
    where: ids?.length ? { id: { in: ids } } : undefined,
    select: { id: true, dayRolledAt: true },
  });

  const stale = rows
    .filter((r) => !r.dayRolledAt || !sameUtcDay(r.dayRolledAt, now))
    .map((r) => r.id);
  if (stale.length === 0) return;

  await prisma.tgAccount.updateMany({
    where: { id: { in: stale } },
    data: {
      sentTodayMsg: 0,
      sentTodayNew: 0,
      dayRolledAt: now,
    },
  });
}
