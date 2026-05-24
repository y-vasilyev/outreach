import { getPrisma } from '@nosquare/db';
import { Queue } from 'bullmq';
import { QueueNames, extractOpenerVariant } from '@nosquare/shared';
import { getRedis } from '../redis.js';
import { publishRealtime } from './realtime-emit.js';
import { logger } from '../logger.js';

// Re-export for existing tests that imported the helper from this module
// (before it moved into @nosquare/shared). New callers should import from
// @nosquare/shared directly.
export { extractOpenerVariant };

let _tgSendQueue: Queue | undefined;
function tgSendQueue(): Queue {
  if (!_tgSendQueue) {
    _tgSendQueue = new Queue(QueueNames.tgSend, { connection: getRedis() });
  }
  return _tgSendQueue;
}

/**
 * Decision payload from `GoalFitEvaluator` (the on_inbound quality gate).
 * Only set for conversations in `semi_auto` / `auto` modes — `assisted` and
 * `manual` skip the gate.
 */
export interface GateDecision {
  action: 'continue' | 'soften' | 'handoff_silent';
  /** 0..1 — how well the draft + exchange fit the campaign's AJTBD. */
  score: number;
}

export interface AutoApproveContext {
  conversationId: string;
  suggestionId: string;
  text: string;
  /** Score 0..1: SafetyFilter confidence-of-fit (1 - risk_score). */
  score: number;
  /**
   * Goal-fit gate decision. When omitted, callers are signalling that the
   * gate did not run (e.g. opener phase, or assisted/manual mode). The
   * composition rule below treats a missing gate as "no goal-fit
   * constraint" — i.e. legacy auto-approve behaviour, gated only by
   * SafetyFilter score. New `auto` mode REQUIRES a gate decision; if the
   * caller set mode=auto without one, we do NOT auto-send.
   */
  gate?: GateDecision;
  /** Optional exact start time. Used for opening messages, not replies. */
  scheduledAt?: string;
  /** Optional random delay window for first-touch outreach. */
  jitterMaxMs?: number;
  /**
   * First-touch openers do not have an inbound exchange, so GoalFitEvaluator
   * cannot run. They are still allowed in strict `auto` mode when the caller
   * explicitly marks the phase and the SafetyFilter score clears T_SAFETY.
   */
  phase?: 'first_touch' | 'reply';
}

/**
 * Composition thresholds. Defaults match `chat-autonomous-modes` design
 * Decision 2. Runtime-tunable via env so we can dial them without a
 * release; per-campaign overrides live on `agent_config.params` for
 * GoalFitEvaluator.
 *
 * - T_SAFETY:           required (1 - risk_score) for any auto-send.
 * - T_SEMI_AUTO_GOALFIT: required gate.score for semi_auto auto-send.
 * - T_AUTO_GOALFIT:      required gate.score for strict-auto auto-send.
 */
function readThreshold(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export const T_SAFETY = readThreshold('AUTOAPPROVE_T_SAFETY', 0.8);
export const T_SEMI_AUTO_GOALFIT = readThreshold('AUTOAPPROVE_T_SEMI_AUTO_GOALFIT', 0.6);
export const T_AUTO_GOALFIT = readThreshold('AUTOAPPROVE_T_AUTO_GOALFIT', 0.75);

function computeDelayMs(ctx: AutoApproveContext): number {
  const jitter = ctx.jitterMaxMs && ctx.jitterMaxMs > 0
    ? Math.floor(Math.random() * ctx.jitterMaxMs)
    : 0;
  if (!ctx.scheduledAt) return jitter;

  const at = new Date(ctx.scheduledAt).getTime();
  if (!Number.isFinite(at)) return jitter;
  return Math.max(0, at - Date.now()) + jitter;
}

/**
 * Fire-and-forget helper used by both campaign-dispatcher (for opening
 * suggestions) and agent-run (for reply suggestions). Auto-approves a
 * suggestion when the conversation's mode plus the safety + goal-fit
 * signals all clear — see composition rule below.
 *
 * Returns `false` when nothing happened (mode disqualifies, score too low,
 * conversation missing, etc.) so the caller can stay quiet.
 *
 * **Composition rule** (chat-autonomous-modes design.md Decision 2):
 *   - mode = manual:    never auto-send.
 *   - mode = assisted:  never auto-send.
 *   - mode = semi_auto: safety must clear T_SAFETY; if a gate decision is
 *                       provided, action must be `continue` or `soften`
 *                       AND gate.score ≥ T_SEMI_AUTO_GOALFIT. If no gate
 *                       decision is provided (opener phase), only safety
 *                       is checked — opener is a one-shot, not a steered
 *                       conversation.
 *   - mode = auto:      safety must clear T_SAFETY; gate decision is
 *                       REQUIRED — action must be exactly `continue` and
 *                       gate.score ≥ T_AUTO_GOALFIT. A missing gate
 *                       decision in `auto` mode short-circuits to false
 *                       (the on_inbound pipeline must always run the
 *                       gate before calling tryAutoApprove for auto).
 */
export async function tryAutoApprove(ctx: AutoApproveContext): Promise<boolean> {
  if (ctx.score < T_SAFETY) return false;

  const prisma = getPrisma();
  const conv = await prisma.conversation.findUnique({
    where: { id: ctx.conversationId },
    select: { id: true, mode: true, tgAccountId: true, status: true },
  });
  if (!conv) return false;
  if (conv.status !== 'active') return false;

  if (conv.mode === 'manual' || conv.mode === 'assisted') return false;

  if (conv.mode === 'semi_auto') {
    if (ctx.gate) {
      if (ctx.gate.action === 'handoff_silent') return false;
      if (ctx.gate.score < T_SEMI_AUTO_GOALFIT) return false;
    }
    // No gate provided (opener) — semi_auto behaves like legacy auto.
  } else if (conv.mode === 'auto') {
    if (!ctx.gate && ctx.phase !== 'first_touch') {
      logger.warn(
        { conversationId: ctx.conversationId, score: ctx.score },
        'tryAutoApprove called for auto-mode conversation without gate decision; refusing to auto-send',
      );
      return false;
    }
    if (ctx.gate) {
      if (ctx.gate.action !== 'continue') return false;
      if (ctx.gate.score < T_AUTO_GOALFIT) return false;
    }
  }

  // Read the source suggestion so we can carry `meta.openerVariant`
  // forward onto the outbound Message (ab-opener-variants change). The
  // field is only honoured when the source agent is an opener composer —
  // for any other agent the column stays null. Reading outside the
  // transaction is fine: the row already exists (the caller created it),
  // and any concurrent update would only flip `status`, never the
  // `agentName` / `meta` we need here.
  const sug = await prisma.suggestion.findUnique({
    where: { id: ctx.suggestionId },
    select: { agentName: true, meta: true },
  });
  const openerVariant = extractOpenerVariant(sug);

  // Mark the suggestion as approved (so the inbox doesn't show it as
  // pending) and create a pending outbound message bound to it. tg-send
  // takes it from there, including jitter and FloodGuard awareness.
  const message = await prisma.$transaction(async (tx) => {
    await tx.suggestion.update({
      where: { id: ctx.suggestionId },
      data: { status: 'approved' },
    });
    return tx.message.create({
      data: {
        conversationId: ctx.conversationId,
        direction: 'out_',
        sender: 'ai',
        text: ctx.text,
        status: 'pending',
        suggestionId: ctx.suggestionId,
        // `openerVariant` is set only when the source suggestion came
        // from an opener composer (`opening_composer` /
        // `agency_opening_composer`); replies and other agents go through
        // `extractOpenerVariant`, which returns null and leaves the
        // column null on the new row.
        ...(openerVariant ? { openerVariant } : {}),
      },
    });
  });

  const delay = computeDelayMs(ctx);
  await tgSendQueue().add(
    'send',
    {
      messageId: message.id,
      conversationId: ctx.conversationId,
      tgAccountId: conv.tgAccountId,
    },
    delay > 0 ? { delay } : undefined,
  );

  await publishRealtime(`conversation:${ctx.conversationId}`, {
    type: 'suggestion.approved',
    conversationId: ctx.conversationId,
    suggestionId: ctx.suggestionId,
    auto: true,
  });

  logger.info(
    {
      conversationId: ctx.conversationId,
      suggestionId: ctx.suggestionId,
      mode: conv.mode,
      score: ctx.score,
      gate: ctx.gate ?? null,
      delay,
      scheduledAt: ctx.scheduledAt,
    },
    'auto-approved suggestion',
  );
  return true;
}
