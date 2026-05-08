import { Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import { AgentRunJobZ, QueueNames, CampaignAjtbdZ, type CampaignAjtbd } from '@nosquare/shared';
import { Errors } from '@nosquare/shared/errors';
import { getPrisma } from '@nosquare/db';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';
import { tryAutoApprove } from '../services/auto-approve.js';
import { buildContactPromptInput } from '../services/agent-input.js';
import { runAgentSafe } from '../services/run-agent-safe.js';
import { ensureContactTgProfile } from '../services/contact-profile.js';

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
interface GateOut {
  score: number;
  action: 'continue' | 'soften' | 'handoff_silent';
  reasons: string[];
}

interface PriorQualityDecision {
  action?: GateOut['action'];
  score?: number;
  decidedAt?: string;
}

/**
 * Hysteresis rule (chat-autonomous-modes spec, conversation-quality-gate):
 * a `handoff_silent` action triggers a mode flip only when EITHER
 *   (a) the immediately-previous decision was also `handoff_silent`, OR
 *   (b) the current `score ≤ 0.3` (severe single-turn fit failure).
 * Anything else is recorded as a decision but does NOT flip the mode.
 */
function shouldFlipOnHandoff(current: GateOut, previous: PriorQualityDecision | null): boolean {
  if (current.action !== 'handoff_silent') return false;
  if (current.score <= 0.3) return true;
  return previous?.action === 'handoff_silent';
}

function readPriorQualityDecision(value: unknown): PriorQualityDecision | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { action?: unknown; score?: unknown; decidedAt?: unknown };
  const action =
    v.action === 'continue' || v.action === 'soften' || v.action === 'handoff_silent'
      ? v.action
      : undefined;
  const score = typeof v.score === 'number' ? v.score : undefined;
  const decidedAt = typeof v.decidedAt === 'string' ? v.decidedAt : undefined;
  if (!action && score === undefined) return null;
  return {
    ...(action ? { action } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(decidedAt ? { decidedAt } : {}),
  };
}

function readAdHocCampaign(meta: unknown): { goalText: string; valueProp: string } {
  if (!meta || typeof meta !== 'object') return { goalText: '', valueProp: '' };
  const adHoc = (meta as { adHoc?: unknown }).adHoc;
  if (!adHoc || typeof adHoc !== 'object') return { goalText: '', valueProp: '' };
  const r = adHoc as { goalText?: unknown; valueProp?: unknown };
  return {
    goalText: typeof r.goalText === 'string' ? r.goalText : '',
    valueProp: typeof r.valueProp === 'string' ? r.valueProp : '',
  };
}

function readOutreachStartAt(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const v = (meta as { outreachStartAt?: unknown }).outreachStartAt;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Resolve the AJTBD framing for a conversation. Returns a parsed
 * `CampaignAjtbd` when the attached campaign has one, or `undefined`
 * when the conversation is ad-hoc (no campaign).
 *
 * **Throws** when the conversation IS attached to a campaign but that
 * campaign's `ajtbd` column is null or fails zod validation. Per
 * `chat-autonomous-modes` design: post-migration every campaign should
 * have a populated AJTBD (the migration backfills a scaffold from
 * goalText/valueProp). A null AJTBD therefore indicates a config bug
 * (e.g. campaign created via a code path that bypassed the zod schema)
 * — we fail loud rather than fall back to a hardcoded default, which
 * would silently degrade quality across the inbound pipeline.
 */
function resolveCampaignAjtbd(campaign: {
  id: string;
  ajtbd: unknown;
} | null | undefined): CampaignAjtbd | undefined {
  if (!campaign) return undefined;
  if (campaign.ajtbd === null || campaign.ajtbd === undefined) {
    throw Errors.internal(
      `campaign ${campaign.id} has no ajtbd; expected scaffold from migration 4_chat_autonomous_modes`,
      { campaignId: campaign.id },
    );
  }
  const parsed = CampaignAjtbdZ.safeParse(campaign.ajtbd);
  if (!parsed.success) {
    throw Errors.internal(
      `campaign ${campaign.id} has invalid ajtbd shape`,
      { campaignId: campaign.id, error: parsed.error.message },
    );
  }
  return parsed.data;
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
            include: {
              contact: { include: { channel: true } },
              campaign: { select: { id: true, ajtbd: true, goalText: true, valueProp: true } },
            },
          });
          if (!conv) throw new Error('conversation not found');

          // Load AJTBD up-front so every agent in this run sees the same
          // framing. Throws (caught by BullMQ → retried/failed) when a
          // campaign exists but its ajtbd is missing/invalid — see
          // resolveCampaignAjtbd doc.
          const ajtbd = resolveCampaignAjtbd(conv.campaign);

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
              ...(ajtbd ? { ajtbd } : {}),
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
              // Keep the legacy campaign block populated when we have one
              // — old prompt templates still reference {{goal_text}} /
              // {{value_prop}}. The new AJTBD block lives alongside.
              campaign: {
                goal_text: conv.campaign?.goalText ?? '',
                value_prop: conv.campaign?.valueProp ?? '',
              },
              ...(ajtbd ? { ajtbd } : {}),
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
                ajtbd_non_goals: ajtbd?.non_goals ?? [],
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

          // ---- Quality gate (semi_auto / auto only) ---------------------
          //
          // Run GoalFitEvaluator after we have at least one safe draft. Gate
          // is skipped entirely for `assisted`/`manual` (cost optimisation)
          // and short-circuited when HandoffDecider already decided to
          // operator_now (we already flipped to manual above; the gate has
          // no work to do).
          let gate: GateOut | null = null;
          if (
            bestSuggestionId &&
            handoff.action !== 'operator_now' &&
            (conv.mode === 'semi_auto' || conv.mode === 'auto') &&
            ajtbd
          ) {
            const previous = readPriorQualityDecision(conv.qualityDecision);
            gate = await runAgentSafe<GateOut>(
              'goal_fit_evaluator',
              {
                ajtbd,
                history_tail: historyTail.slice(-8),
                intent: { intent: intent.intent, confidence: intent.confidence },
                handoff: { action: handoff.action, reason: handoff.reason },
                draft: bestText,
                previous_decision: previous,
              },
              { conversationId: conv.id },
            );

            if (gate) {
              const decidedAt = new Date().toISOString();
              const flip = conv.mode === 'auto' && shouldFlipOnHandoff(gate, previous);

              // Persist the decision (and optionally flip mode) in one tx
              // so the operator's view is consistent — they never see a
              // mode change without an accompanying decision, or vice
              // versa.
              await prisma.$transaction(async (tx) => {
                await tx.conversation.update({
                  where: { id: conv.id },
                  data: {
                    qualityDecision: {
                      score: gate!.score,
                      action: gate!.action,
                      reasons: gate!.reasons,
                      decidedAt,
                    },
                    ...(flip ? { mode: 'assisted' } : {}),
                  },
                });
              });

              // Operator-only realtime: gate decision + (when applicable)
              // mode change. The contact must perceive nothing — see the
              // silent-fallback contract in
              // openspec/changes/chat-autonomous-modes/specs/conversation-quality-gate/spec.md
              await publishRealtime(`conversation:${conv.id}`, {
                type: 'quality.gate',
                conversationId: conv.id,
                score: gate.score,
                action: gate.action,
                reasons: gate.reasons,
                decidedAt,
              });
              if (flip) {
                await publishRealtime(`conversation:${conv.id}`, {
                  type: 'mode.changed',
                  conversationId: conv.id,
                  mode: 'assisted',
                });
                logger.info(
                  {
                    conversationId: conv.id,
                    score: gate.score,
                    reasons: gate.reasons,
                    previousAction: previous?.action ?? null,
                  },
                  'quality gate: silent handoff — flipped auto → assisted',
                );
              }

              // After a flip the suggestion stays `pending` for the
              // operator. Skip auto-approve below.
              if (flip) {
                return { ok: true, action: handoff.action, gate: gate.action, flipped: true };
              }
            }
          }

          // Auto-mode reply: composition rule lives in `tryAutoApprove`.
          // For semi_auto / auto we pass the gate decision so it can
          // enforce the goal-fit thresholds. For assisted / manual the
          // helper short-circuits.
          if (bestSuggestionId) {
            await tryAutoApprove({
              conversationId: conv.id,
              suggestionId: bestSuggestionId,
              text: bestText,
              score: bestScore,
              ...(gate ? { gate: { action: gate.action, score: gate.score } } : {}),
            });
          }

          return { ok: true, action: handoff.action, gate: gate?.action ?? null };
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

          await ensureContactTgProfile(conv.tgAccountId, conv.contact);
          const contact = await prisma.contact.findUnique({
            where: { id: conv.contact.id },
            include: { channel: true },
          });
          if (!contact) throw new Error('contact not found');

          const adHoc = readAdHocCampaign(conv.meta);
          const goalText = conv.campaign?.goalText ?? adHoc.goalText;
          const valueProp = conv.campaign?.valueProp ?? adHoc.valueProp;
          const scheduledAt = readOutreachStartAt(conv.meta);

          // Recent posts are required for the new prompt's "one concrete
          // hook" rule. Without them OpeningComposer falls back to generic
          // intros — exactly the AI-style "разнообразные темы: от X до Y"
          // we're trying to kill. Pull from channel.rawData (set by the
          // scrape worker) and pass as a typed array.
          const rawPosts =
            ((contact.channel?.rawData as
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
              channel_analysis: contact.channel?.analysis ?? {},
              contact: buildContactPromptInput(contact),
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
                channel_analysis: contact.channel?.analysis ?? {},
                contact: { id: contact.id },
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

          if (bestSuggestionId && (contact.status === 'qualified' || contact.status === 'new')) {
            await prisma.contact.update({
              where: { id: contact.id },
              data: { status: 'contacted' },
            });
          }

          if (bestSuggestionId) {
            await tryAutoApprove({
              conversationId: conv.id,
              suggestionId: bestSuggestionId,
              text: bestText,
              score: bestScore,
              scheduledAt,
              jitterMaxMs: 2 * 60 * 60 * 1000,
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
