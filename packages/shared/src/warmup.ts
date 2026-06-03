/**
 * TG account warmup ladder. Cold sessions don't get to send 30/day on day 1
 * — the cap ramps up over weeks, gated by both calendar days and the actual
 * reply-rate the account is getting from its contacts. Stage 4 means
 * "warmup over, operator's `dailyMsgLimit` is the only constraint".
 *
 * Numbers here are intentionally conservative. They were picked to keep a
 * fresh session well below TG's per-account abuse thresholds while still
 * letting a healthy account reach full throughput in ~3 weeks.
 *
 * The actual effective cap a tg-send / campaign-dispatcher sees is the
 * `min` of operator-set `dailyMsgLimit` and the stage cap. So an operator
 * can freeze an account *lower* than its warmup-allowed maximum, but never
 * higher: warmup is the ceiling, the per-account number is the floor.
 *
 * Reply-rate gate: at each stage transition we require at least
 * `minSendsForReplyRate` outbounds since warmup started AND a reply-rate
 * of at least `minReplyRate` over the same window. Below the send count
 * threshold we skip the gate (not enough data) but still require the day
 * dwell. If reply-rate is below threshold the account FREEZES at its
 * current stage (we don't demote — that's the reply-rate-guard's job).
 */

/** Sentinel meaning "no warmup cap" (operator's dailyMsgLimit is unrestricted). */
export const WARMUP_UNCAPPED = Number.MAX_SAFE_INTEGER;

export interface WarmupStageDef {
  /** 0..4. */
  stage: number;
  /** Warmup-imposed daily outbound cap. `WARMUP_UNCAPPED` = no cap from warmup. */
  msgPerDay: number;
  /** Same idea, applied to *new* contacts (vs reply turns to existing ones). */
  newContactsPerDay: number;
  /**
   * Cumulative days since `warmupStartedAt` before this stage is reachable.
   * The promoter checks `daysSinceStart >= minDaysSinceStart` together with
   * the reply-rate gate before bumping into this stage.
   */
  minDaysSinceStart: number;
  /** Reply-rate floor required to promote INTO this stage. */
  minReplyRate: number;
  /** Min outbound count before the reply-rate gate is evaluated. */
  minSendsForReplyRate: number;
}

export const WARMUP_STAGES: readonly WarmupStageDef[] = [
  { stage: 0, msgPerDay: 5,             newContactsPerDay: 3,             minDaysSinceStart: 0,  minReplyRate: 0,    minSendsForReplyRate: 0 },
  { stage: 1, msgPerDay: 12,            newContactsPerDay: 7,             minDaysSinceStart: 3,  minReplyRate: 0.05, minSendsForReplyRate: 10 },
  { stage: 2, msgPerDay: 25,            newContactsPerDay: 12,            minDaysSinceStart: 7,  minReplyRate: 0.05, minSendsForReplyRate: 30 },
  { stage: 3, msgPerDay: 40,            newContactsPerDay: 18,            minDaysSinceStart: 14, minReplyRate: 0.05, minSendsForReplyRate: 60 },
  { stage: 4, msgPerDay: WARMUP_UNCAPPED, newContactsPerDay: WARMUP_UNCAPPED, minDaysSinceStart: 21, minReplyRate: 0.05, minSendsForReplyRate: 100 },
];

export const WARMUP_TOP_STAGE = WARMUP_STAGES[WARMUP_STAGES.length - 1]!.stage;

export function getWarmupStage(stage: number): WarmupStageDef {
  const clamped = Math.max(0, Math.min(stage, WARMUP_TOP_STAGE));
  return WARMUP_STAGES[clamped]!;
}

/**
 * Resolve the effective daily caps for an account, taking the smaller of
 * the operator-set per-account number and the warmup-stage cap. This is
 * the value tg-send / campaign-dispatcher must actually compare
 * `sentTodayMsg` / `sentTodayNew` against, NOT the raw `dailyMsgLimit`.
 */
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

/**
 * Whole days that have elapsed since `start`. Rounds down. Returns 0 for a
 * null/future start.
 */
export function daysSince(start: Date | string | null | undefined, now: Date = new Date()): number {
  if (!start) return 0;
  const d = typeof start === 'string' ? new Date(start) : start;
  if (Number.isNaN(d.getTime())) return 0;
  const diff = now.getTime() - d.getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

/**
 * Promotion proposal for an account at `currentStage` whose warmup started
 * at `warmupStartedAt`. The promoter calls this and, when `nextStage` is
 * non-null, evaluates the reply-rate gate before committing the bump.
 *
 * - `null` next stage means "no further promotion possible right now"
 *   (already at top OR day dwell not met).
 */
export function nextPromotionCandidate(
  currentStage: number,
  warmupStartedAt: Date | string | null,
  now: Date = new Date(),
): WarmupStageDef | null {
  if (currentStage >= WARMUP_TOP_STAGE) return null;
  if (!warmupStartedAt) return null;
  const days = daysSince(warmupStartedAt, now);
  const target = WARMUP_STAGES[currentStage + 1];
  if (!target) return null;
  if (days < target.minDaysSinceStart) return null;
  return target;
}
