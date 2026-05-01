import { Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import { AgentRunJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';
import { tryAutoApprove } from '../services/auto-approve.js';
import { buildContactPromptInput } from '../services/agent-input.js';
import { runAgentSafe } from '../services/run-agent-safe.js';

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

          // Both intent_classifier and handoff_decider expect history_tail as
          // string[] (one line per turn). Templates render arrays via
          // JSON.stringify so the prompt still reads sensibly.
          const historyTail = messages
            .slice(-10)
            .map((m) => `${m.direction === 'in_' ? '<<' : '>>'} ${m.text}`);

          // Each agent step uses runAgentSafe — a failure flips the
          // conversation into `assisted` (so the operator drives), publishes
          // an `agent.failed` event, and returns null. Per CLAUDE.md "не
          // ронять оператору диалог". We never re-throw to BullMQ from
          // these advisory steps; otherwise the whole pipeline retries and
          // we burn quota on the steps that already succeeded.

          const intent = await runAgentSafe<IntentOut>(
            'intent_classifier',
            { last_inbound: last.text, history_tail: historyTail },
            { conversationId: conv.id },
          );
          if (!intent) {
            return { ok: true, degraded: 'intent_classifier_failed' };
          }

          const handoff = await runAgentSafe<HandoffOut>(
            'handoff_decider',
            {
              conversation: {
                mode: conv.mode,
                summary: conv.summary ?? '',
                last_inbound: last.text,
                history_tail: historyTail,
              },
              intent: { intent: intent.intent, confidence: intent.confidence },
              ai_recent_confidence: [intent.confidence],
              red_flags_total: 0,
            },
            { conversationId: conv.id },
          );
          // No handoff = degrade to assisted (already done by runAgentSafe)
          // and stop. The operator now sees the conversation with the
          // banner and can write the reply themselves.
          if (!handoff) {
            return { ok: true, degraded: 'handoff_decider_failed' };
          }

          // Handoff=operator_now flips the conversation into manual mode and
          // pings the operator room — but we still run ReplyComposer below
          // so the operator opens an already-loaded scratchpad of
          // suggestions instead of a blank page. Suggestions are advisory
          // in manual mode (no auto-approve), so this is purely additive.
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
          }

          // generate replies + safety filter. The DB stores message
          // direction as `in_`/`out_` (Prisma underscored enum); the agent
          // schema wants `in`/`out`.
          const reply = await runAgentSafe<ReplyComposerOut>(
            'reply_composer',
            {
              channel_analysis: conv.contact.channel?.analysis ?? {},
              contact: buildContactPromptInput(conv.contact),
              campaign: { goal_text: '', value_prop: '' },
              conversation_history: messages.map((m) => ({
                direction: m.direction === 'in_' ? 'in' : 'out',
                sender: m.sender,
                text: m.text,
                at: m.createdAt.toISOString(),
              })),
              last_inbound: { text: last.text, intent: intent.intent, sentiment: 'neutral' },
            },
            { conversationId: conv.id },
          );
          if (!reply) {
            return { ok: true, degraded: 'reply_composer_failed', action: handoff.action };
          }

          // Track the top variant so we can auto-approve it once at the end
          // (rather than approving the first that clears safety, which may
          // not be the best one).
          let bestSuggestionId: string | null = null;
          let bestScore = 0;
          let bestText = '';

          for (const v of reply.variants) {
            const safety = await runAgentSafe<SafetyOut>(
              'safety_filter',
              {
                draft: v.text,
                channel_analysis: conv.contact.channel?.analysis ?? {},
                contact: { id: conv.contact.id },
                campaign: {},
              },
              { conversationId: conv.id },
            );
            // safety_filter null → skip this variant only; don't kill the
            // batch. Other variants may still pass and reach the operator.
            if (!safety) continue;
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

          // Recent posts are required for the new prompt's "one concrete
          // hook" rule. Without them OpeningComposer falls back to generic
          // intros — exactly the AI-style "разнообразные темы: от X до Y"
          // we're trying to kill. Pull from channel.rawData (set by the
          // scrape worker) and pass as a typed array.
          const rawPosts =
            ((conv.contact.channel?.rawData as
              | { posts?: { text?: string; date?: string }[] }
              | null
              | undefined)?.posts ?? []).slice(0, 5);
          const recentPosts = rawPosts.map((p) => ({
            ...(p.date ? { date: p.date } : {}),
            text: p.text ?? '',
          }));

          const opener = await runAgentSafe<OpenerOut>(
            'opening_composer',
            {
              channel_analysis: conv.contact.channel?.analysis ?? {},
              contact: buildContactPromptInput(conv.contact),
              strategy: { approach: 'industry_fit' },
              campaign: { goal_text: goalText, value_prop: valueProp },
              recent_posts: recentPosts,
            },
            {
              conversationId: conv.id,
              ...(conv.campaignId ? { campaignId: conv.campaignId } : {}),
              contactId: conv.contact.id,
            },
          );
          if (!opener) {
            return { ok: true, degraded: 'opening_composer_failed' };
          }

          let bestSuggestionId: string | null = null;
          let bestScore = 0;
          let bestText = '';

          for (const v of opener.variants) {
            const safety = await runAgentSafe<SafetyOut>(
              'safety_filter',
              {
                draft: v.text,
                channel_analysis: conv.contact.channel?.analysis ?? {},
                contact: { id: conv.contact.id },
                campaign: { name: conv.campaign?.name ?? 'ad-hoc' },
              },
              { conversationId: conv.id },
            );
            if (!safety) continue;
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
