// Local mirror of @nosquare/shared/warmup. Web doesn't depend on the
// shared package directly (see other features/*/types.ts) — we keep a
// terse copy of the bits the UI actually needs. Keep in sync with
// packages/shared/src/warmup.ts.

export const WARMUP_UNCAPPED = Number.MAX_SAFE_INTEGER;

export interface WarmupStageDef {
  stage: number;
  msgPerDay: number;
  newContactsPerDay: number;
  minDaysSinceStart: number;
  minReplyRate: number;
  minSendsForReplyRate: number;
}

export const WARMUP_STAGES: readonly WarmupStageDef[] = [
  { stage: 0, msgPerDay: 5,               newContactsPerDay: 3,               minDaysSinceStart: 0,  minReplyRate: 0,    minSendsForReplyRate: 0 },
  { stage: 1, msgPerDay: 12,              newContactsPerDay: 7,               minDaysSinceStart: 3,  minReplyRate: 0.05, minSendsForReplyRate: 10 },
  { stage: 2, msgPerDay: 25,              newContactsPerDay: 12,              minDaysSinceStart: 7,  minReplyRate: 0.05, minSendsForReplyRate: 30 },
  { stage: 3, msgPerDay: 40,              newContactsPerDay: 18,              minDaysSinceStart: 14, minReplyRate: 0.05, minSendsForReplyRate: 60 },
  { stage: 4, msgPerDay: WARMUP_UNCAPPED, newContactsPerDay: WARMUP_UNCAPPED, minDaysSinceStart: 21, minReplyRate: 0.05, minSendsForReplyRate: 100 },
];

export const WARMUP_TOP_STAGE = WARMUP_STAGES[WARMUP_STAGES.length - 1]!.stage;

export function getWarmupStage(stage: number): WarmupStageDef {
  const clamped = Math.max(0, Math.min(stage, WARMUP_TOP_STAGE));
  return WARMUP_STAGES[clamped]!;
}

export function effectiveDailyLimits(account: {
  dailyMsgLimit: number;
  dailyNewContactLimit: number;
  warmupStage: number;
}): { msgPerDay: number; newContactsPerDay: number } {
  const s = getWarmupStage(account.warmupStage);
  return {
    msgPerDay: Math.min(account.dailyMsgLimit, s.msgPerDay),
    newContactsPerDay: Math.min(account.dailyNewContactLimit, s.newContactsPerDay),
  };
}

export function daysSince(start: Date | string | null | undefined, now: Date = new Date()): number {
  if (!start) return 0;
  const d = typeof start === 'string' ? new Date(start) : start;
  if (Number.isNaN(d.getTime())) return 0;
  const diff = now.getTime() - d.getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}
