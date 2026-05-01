import { isAppError } from '@nosquare/shared/errors';
import { getPrisma } from '@nosquare/db';

import { logger } from '../logger.js';
import { publishRealtime } from './realtime-emit.js';
import { getRunner } from './runner.js';

/**
 * Run an agent inside an inbound-pipeline step. If the agent fails:
 *   - log structured error
 *   - flip the conversation to `assisted` (so the operator drives, not the AI)
 *   - emit `agent.failed` realtime event so the UI can show a banner
 *   - return `null` rather than throw
 *
 * Why: the AGENT_RUN BullMQ job owns the whole inbound pipeline (intent →
 * handoff → reply → safety). If any one of those throws, the job retries —
 * which means the operator sees nothing on the screen for a while, and we
 * burn quota repeatedly on the steps that already succeeded. The contract
 * from CLAUDE.md is "Не ронять оператору диалог. Любая ошибка в пайплайне
 * → диалог в `assisted` с пометкой и причиной." This helper enforces it.
 *
 * The caller decides whether the rest of the pipeline can proceed without
 * this agent's output (e.g. reply_composer is advisory, but
 * intent_classifier feeds handoff_decider). If `null` makes the rest
 * impossible, the caller short-circuits with a return — NOT a throw.
 */
export async function runAgentSafe<T>(
  agentName: string,
  input: unknown,
  ctx: { conversationId: string; channelId?: string; contactId?: string; campaignId?: string },
): Promise<T | null> {
  const runner = getRunner();
  try {
    return await runner.run<T>(agentName, input, ctx);
  } catch (e) {
    const code = isAppError(e) ? e.code : 'INTERNAL';
    const reason = e instanceof Error ? e.message : String(e);
    logger.error(
      {
        event: 'pipeline.agentFailed',
        agent: agentName,
        conversationId: ctx.conversationId,
        code,
        err: reason,
      },
      'agent failed in pipeline — degrading conversation to assisted',
    );

    try {
      const prisma = getPrisma();
      // Only step DOWN — never auto-promote. If the conversation is already
      // `manual` (operator already in control) we leave it alone; degrading
      // to `assisted` would be an upgrade for them.
      const conv = await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: { mode: true },
      });
      if (conv && conv.mode === 'auto') {
        await prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: { mode: 'assisted' },
        });
        await publishRealtime(`conversation:${ctx.conversationId}`, {
          type: 'mode.changed',
          conversationId: ctx.conversationId,
          mode: 'assisted',
        });
      }
      await publishRealtime(`conversation:${ctx.conversationId}`, {
        type: 'agent.failed',
        conversationId: ctx.conversationId,
        agentName,
        code,
        reason: shortReason(reason),
      });
    } catch (emitErr) {
      // Realtime/DB write must never re-throw out of the safe wrapper.
      logger.error(
        { err: (emitErr as Error).message },
        'failed to emit agent.failed degradation event',
      );
    }

    return null;
  }
}

function shortReason(s: string): string {
  if (typeof s !== 'string') return '';
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}
