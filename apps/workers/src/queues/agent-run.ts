import { Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import { AgentRunJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { getRunner } from '../services/runner.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';
import { tryAutoApprove } from '../services/auto-approve.js';

interface IntentOut {
  intent: string;
  confidence: number;
  signals?: string[];
}
interface HandoffOut {
  action: 'ai_continue' | 'ai_suggest_only' | 'operator_now';
  reason: string;
  urgency: 'low' | 'normal' | 'high';
}
interface ReplyComposerOut {
  variants: Array<{ text: string; intent_target: string; rationale: string }>;
}
interface OpenerOut {
  variants: Array<{ text: string; rationale: string; risk_score?: number }>;
}
interface SafetyOut {
  allow: boolean;
  reasons: string[];
  rewrite_hint?: string;
  risk_score: number;
}

export function startAgentRunWorker() {
  const worker = new Worker(
    QueueNames.agentRun,
    async (job) => {
      const data = AgentRunJobZ.parse(job.data);
      const prisma = getPrisma();
      const runner = getRunner();

      switch (data.pipeline) {
        case 'on_inbound': {
          if (!data.conversationId) throw new Error('conversationId required');
          const conv = await prisma.conversation.findUnique({
            where: { id: data.conversationId },
            include: { contact: { include: { channel: true } } },
          });
          if (!conv) throw new Error('conversation not found');

          const messages = await prisma.message.findMany({
            where: { conversationId: conv.id },
            orderBy: { createdAt: 'asc' },
            take: 50,
          });
          const last = [...messages].reverse().find((m) => m.direction === 'in_');
          if (!last) return { ok: true, skipped: 'no inbound' };

          const historyTail = messages
            .slice(-10)
            .map((m) => `${m.direction === 'in_' ? '<<' : '>>'} ${m.text}`)
            .join('\n');

          const intent = await runner.run<IntentOut>('intent_classifier', {
            last_inbound: last.text,
            history_tail: historyTail,
          }, { conversationId: conv.id });

          const handoff = await runner.run<HandoffOut>('handoff_decider', {
            mode: conv.mode,
            summary: conv.summary ?? '',
            history_tail: historyTail,
            intent: intent.intent,
            ai_recent_confidence: [intent.confidence],
            red_flags_total: 0,
          }, { conversationId: conv.id });

          if (handoff.action === 'operator_now') {
            await prisma.conversation.update({
              where: { id: conv.id },
              data: { mode: 'manual' },
            });
            await publishRealtime(`conversation:${conv.id}`, {
              type: 'mode.changed',
              conversationId: conv.id,
              mode: 'manual',
            });
            await publishRealtime(`operator:default`, {
              type: 'operator.assigned',
              conversationId: conv.id,
              reason: handoff.reason,
              urgency: handoff.urgency,
            });
            return { ok: true, action: 'operator_now' };
          }

          // generate replies + safety filter
          const reply = await runner.run<ReplyComposerOut>('reply_composer', {
            channel_analysis: conv.contact.channel?.analysis ?? {},
            contact: { id: conv.contact.id, value: conv.contact.value, role: conv.contact.roleGuess },
            campaign: { goal_text: '', value_prop: '' },
            conversation_history: messages.map((m) => ({
              direction: m.direction,
              sender: m.sender,
              text: m.text,
              at: m.createdAt.toISOString(),
            })),
            last_inbound: { text: last.text, intent: intent.intent, sentiment: 'neutral' },
          }, { conversationId: conv.id });

          // Track the top variant so we can auto-approve it once at the end
          // (rather than approving the first that clears safety, which may
          // not be the best one).
          let bestSuggestionId: string | null = null;
          let bestScore = 0;
          let bestText = '';

          for (const v of reply.variants) {
            const safety = await runner.run<SafetyOut>('safety_filter', {
              draft: v.text,
              channel_analysis: conv.contact.channel?.analysis ?? {},
              contact: { id: conv.contact.id },
              campaign: {},
            }, { conversationId: conv.id });
            if (!safety.allow) continue;
            const score = 1 - safety.risk_score;
            const sug = await prisma.suggestion.create({
              data: {
                conversationId: conv.id,
                agentName: 'reply_composer',
                text: v.text,
                rationale: v.rationale,
                score,
                status: 'pending',
              },
            });
            await publishRealtime(`conversation:${conv.id}`, {
              type: 'suggestion.new',
              conversationId: conv.id,
              suggestion: {
                id: sug.id,
                agentName: sug.agentName,
                text: sug.text,
                rationale: sug.rationale,
                score: Number(sug.score),
                status: sug.status,
                createdAt: sug.createdAt.toISOString(),
              },
            });
            if (score > bestScore) {
              bestScore = score;
              bestSuggestionId = sug.id;
              bestText = v.text;
            }
          }

          // Auto-mode reply: if conv.mode === 'auto' and the top suggestion
          // is high-confidence + low-risk, send it without waiting for the
          // operator. tryAutoApprove is a no-op for assisted/manual modes.
          if (bestSuggestionId) {
            await tryAutoApprove({
              conversationId: conv.id,
              suggestionId: bestSuggestionId,
              text: bestText,
              score: bestScore,
            });
          }

          return { ok: true, action: handoff.action };
        }

        case 'outreach_first_message': {
          // On-demand opener generation. Used by `POST
          // /contacts/:id/start-conversation` so the operator can kick
          // off a chat with a specific contact without waiting for the
          // campaign-dispatcher tick. Mirrors the dispatcher's logic but
          // runs as a discrete BullMQ job so the API can return fast.
          if (!data.conversationId) throw new Error('conversationId required');
          const conv = await prisma.conversation.findUnique({
            where: { id: data.conversationId },
            include: {
              contact: { include: { channel: true } },
              campaign: true,
            },
          });
          if (!conv) throw new Error('conversation not found');

          const goalText = conv.campaign?.goalText ?? '';
          const valueProp = conv.campaign?.valueProp ?? '';

          const opener = await runner.run<OpenerOut>(
            'opening_composer',
            {
              channel_analysis: conv.contact.channel?.analysis ?? {},
              contact: {
                value: conv.contact.value,
                role: conv.contact.roleGuess,
                type: conv.contact.type,
              },
              strategy: { approach: 'industry_fit' },
              campaign: { goal_text: goalText, value_prop: valueProp },
            },
            {
              conversationId: conv.id,
              campaignId: conv.campaignId ?? undefined,
              contactId: conv.contact.id,
            },
          );

          let bestSuggestionId: string | null = null;
          let bestScore = 0;
          let bestText = '';

          for (const v of opener.variants) {
            const safety = await runner.run<SafetyOut>(
              'safety_filter',
              {
                draft: v.text,
                channel_analysis: conv.contact.channel?.analysis ?? {},
                contact: { id: conv.contact.id },
                campaign: { name: conv.campaign?.name ?? 'ad-hoc' },
              },
              { conversationId: conv.id },
            );
            if (!safety.allow) continue;
            const score = 1 - safety.risk_score;
            const sug = await prisma.suggestion.create({
              data: {
                conversationId: conv.id,
                agentName: 'opening_composer',
                text: v.text,
                rationale: v.rationale,
                score,
                status: 'pending',
              },
            });
            await publishRealtime(`conversation:${conv.id}`, {
              type: 'suggestion.new',
              conversationId: conv.id,
              suggestion: {
                id: sug.id,
                agentName: sug.agentName,
                text: sug.text,
                rationale: sug.rationale,
                score: Number(sug.score),
                status: sug.status,
                createdAt: sug.createdAt.toISOString(),
              },
            });
            if (score > bestScore) {
              bestScore = score;
              bestSuggestionId = sug.id;
              bestText = v.text;
            }
          }

          if (conv.contact.status === 'qualified' || conv.contact.status === 'new') {
            await prisma.contact.update({
              where: { id: conv.contact.id },
              data: { status: 'contacted' },
            });
          }

          if (bestSuggestionId) {
            await tryAutoApprove({
              conversationId: conv.id,
              suggestionId: bestSuggestionId,
              text: bestText,
              score: bestScore,
            });
          }

          return { ok: true, suggestions: opener.variants.length };
        }

        default:
          logger.warn({ pipeline: data.pipeline }, 'pipeline not implemented yet');
          return { ok: false, reason: 'not implemented' };
      }
    },
    { connection: getRedis(), concurrency: 4 },
  );

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err?.message }, 'agent-run failed'),
  );
  return worker;
}
