import { Worker, Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import {
  AgentRunJobZ,
  QueueNames,
  CampaignAjtbdZ,
  isWithinSchedule,
  flags,
  resolveSafetyContext,
  resolveForceHandoffIntents,
  resolveAgentName,
  type CampaignAjtbd,
  type CampaignSchedule,
  type ResolvedSafetyContext,
} from '@nosquare/shared';
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
interface NextActionOut {
  next_action: 'send_now' | 'wait_hours' | 'send_followup_at' | 'close' | 'escalate';
  scheduled_at?: string;
  reason: string;
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
 *
 * Exported so tests can pin the boundary cases (score = 0.3 vs 0.31 vs 0.4
 * crossed with prev=continue vs prev=handoff_silent). Pure function — no
 * side effects.
 */
export function shouldFlipOnHandoff(
  current: GateOut,
  previous: PriorQualityDecision | null,
): boolean {
  if (current.action !== 'handoff_silent') return false;
  if (current.score <= 0.3) return true;
  return previous?.action === 'handoff_silent';
}

export function readPriorQualityDecision(value: unknown): PriorQualityDecision | null {
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

function canAutoSendOpening(campaign: {
  status: string;
  schedule: unknown;
} | null | undefined): boolean {
  if (!campaign) return true;
  if (campaign.status !== 'running') return false;
  return isWithinSchedule((campaign.schedule ?? {}) as CampaignSchedule);
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

/**
 * Extra SafetyFilter args derived from a campaign type's `safetyProfile`:
 * the topic lists (agent input) and the params override (max_length /
 * allow_links). Returns `null` when `ENABLE_CAMPAIGN_TYPES` is off so the
 * call site passes NEITHER overrides nor topic vars — i.e. byte-for-byte
 * the pre-registry SafetyFilter invocation (DB params untouched).
 */
interface SafetyExtras {
  forbidden_topics: string[];
  allowed_topics: string[];
  overrides: { params: { max_length: number; allow_links: boolean } };
}

function safetyExtrasForCampaign(
  campaign: { type?: { safetyProfile: unknown } | null } | null | undefined,
): SafetyExtras | null {
  if (!flags.ENABLE_CAMPAIGN_TYPES) return null;
  const ctx: ResolvedSafetyContext = resolveSafetyContext(campaign?.type?.safetyProfile ?? null);
  return {
    forbidden_topics: ctx.forbidden_topics,
    allowed_topics: ctx.allowed_topics,
    overrides: { params: ctx.params },
  };
}

/**
 * Resolve the agent_config name for a pipeline role given the campaign's
 * type (B2 worker wiring, agency-sourcing-matching). Behind
 * `ENABLE_AGENCY_SOURCING`: when the conversation's campaign is an
 * `agency_sourcing` type, the type's `agentSet` maps roles to agency agents
 * (e.g. `opening_composer → agency_opening_composer`). Otherwise (flag off,
 * no type, or a non-agency type) it returns the literal `fallback`, keeping
 * the CustDev path byte-for-byte on the legacy global agent names.
 */
function resolveRoleAgent(
  campaign:
    | { type?: { key?: string | null; agentSet?: unknown } | null }
    | null
    | undefined,
  role: string,
  fallback: string,
): string {
  if (!flags.ENABLE_AGENCY_SOURCING) return fallback;
  if (campaign?.type?.key !== 'agency_sourcing') return fallback;
  return resolveAgentName(campaign.type.agentSet ?? null, role, fallback);
}

function isAgencyConversation(
  campaign: { type?: { key?: string | null } | null } | null | undefined,
): boolean {
  return Boolean(flags.ENABLE_AGENCY_SOURCING && campaign?.type?.key === 'agency_sourcing');
}

let _profileExtractQueue: Queue | undefined;
function profileExtractQueue(): Queue {
  if (!_profileExtractQueue) {
    _profileExtractQueue = new Queue(QueueNames.profileExtract, { connection: getRedis() });
  }
  return _profileExtractQueue;
}

/**
 * `on_inbound` pipeline body, exported for unit-testing the silent
 * fallback contract (see `chat-autonomous-modes` design Decision 5):
 * when the gate trips `handoff_silent` in `auto` mode, no `out_`
 * message, no `tg-send` job, and no contact-facing realtime event are
 * produced. Tests pin those invariants with mocked deps; the worker
 * itself is a thin BullMQ dispatcher around this function.
 */
export async function handleOnInbound(data: { conversationId?: string }): Promise<unknown> {
  const prisma = getPrisma();
  if (!data.conversationId) throw new Error('conversationId required');
          const conv = await prisma.conversation.findUnique({
            where: { id: data.conversationId },
            include: {
              contact: { include: { channel: true } },
              campaign: {
                select: {
                  id: true,
                  ajtbd: true,
                  goalText: true,
                  valueProp: true,
                  type: {
                    select: {
                      key: true,
                      safetyProfile: true,
                      autonomyPolicy: true,
                      agentSet: true,
                    },
                  },
                },
              },
            },
          });
          if (!conv) throw new Error('conversation not found');

          // Load AJTBD up-front so every agent in this run sees the same
          // framing. Throws (caught by BullMQ → retried/failed) when a
          // campaign exists but its ajtbd is missing/invalid — see
          // resolveCampaignAjtbd doc.
          const ajtbd = resolveCampaignAjtbd(conv.campaign);

          // Campaign-type safety profile + force-handoff intents. Behind the
          // flag: when off, `safetyExtras` is null (no overrides, no topic
          // vars) and no extra escalation intents apply, so the SafetyFilter
          // invocation is byte-for-byte the pre-registry path.
          const safetyExtras = safetyExtrasForCampaign(conv.campaign);
          const forceHandoffIntents = flags.ENABLE_CAMPAIGN_TYPES
            ? resolveForceHandoffIntents(conv.campaign?.type?.autonomyPolicy ?? null)
            : [];

          const messages = await prisma.message.findMany({
            where: { conversationId: conv.id },
            orderBy: { createdAt: 'asc' },
            take: 50,
          });
          const last = [...messages].reverse().find((m) => m.direction === 'in_');
          if (!last) return { ok: true, skipped: 'no inbound' };

          // Profile extraction (agency-sourcing-matching M5, task 5.2): for
          // agency_sourcing conversations (behind ENABLE_AGENCY_SOURCING) fan
          // out a profile-extract job keyed to THIS inbound. Additive + fully
          // separate from the CustDev reply pipeline below; failures there
          // never touch the inbound flow. Enqueued early so it runs even if a
          // later advisory step degrades the conversation.
          if (isAgencyConversation(conv.campaign)) {
            await profileExtractQueue()
              .add('extract', { conversationId: conv.id, sourceMessageId: last.id })
              .catch((err: unknown) =>
                logger.warn(
                  { conversationId: conv.id, err: (err as Error).message },
                  'failed to enqueue profile-extract job',
                ),
              );
          }

          // Both intent_classifier and handoff_decider expect history_tail as
          // string[] (one line per turn). Templates render arrays via
          // JSON.stringify so the prompt still reads sensibly.
          const historyTail = messages
            .slice(-10)
            .map((m) => `${m.direction === 'in_' ? '<<' : '>>'} ${m.text}`);

          if (messages.length > 0 && messages.length % 20 === 0) {
            const summary = await runAgentSafe<{
              summary: string;
              key_facts: string[];
              open_questions: string[];
            }>(
              'conversation_summarizer',
              {
                previous_summary: conv.summary ?? '',
                history: messages.map((m) => ({
                  direction: m.direction === 'in_' ? 'in' : 'out',
                  sender: m.sender,
                  text: m.text,
                  at: m.createdAt.toISOString(),
                })),
              },
              { conversationId: conv.id },
            );
            if (summary) {
              await prisma.conversation.update({
                where: { id: conv.id },
                data: { summary: summary.summary },
              });
            }
          }

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

          // Campaign-type force-handoff intents (e.g. agency price/quote):
          // promote to operator_now so a human confirms commercial terms.
          // Deterministic, runs before the operator_now side-effects below.
          if (forceHandoffIntents.includes(intent.intent) && handoff.action !== 'operator_now') {
            handoff.action = 'operator_now';
            handoff.reason = `force_handoff_intent:${intent.intent}`;
            handoff.urgency = 'high';
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
          //
          // B2 (agency-sourcing-matching): for agency_sourcing conversations
          // (behind ENABLE_AGENCY_SOURCING) the reply role resolves via the
          // type's agentSet; it maps `reply_composer → reply_composer` today,
          // so this is a no-op until a type remaps it. CustDev / flag-off stays
          // on the literal `reply_composer`.
          const replyAgent = resolveRoleAgent(conv.campaign, 'reply_composer', 'reply_composer');
          const reply = await runAgentSafe<ReplyComposerOut>(
            replyAgent,
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
                ...(safetyExtras
                  ? {
                      forbidden_topics: safetyExtras.forbidden_topics,
                      allowed_topics: safetyExtras.allowed_topics,
                    }
                  : {}),
                ajtbd_non_goals: ajtbd?.non_goals ?? [],
              },
              {
                conversationId: conv.id,
                ...(safetyExtras ? { overrides: safetyExtras.overrides } : {}),
              },
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
              phase: 'reply',
              ...(gate ? { gate: { action: gate.action, score: gate.score } } : {}),
            });
          }

          return { ok: true, action: handoff.action, gate: gate?.action ?? null };
}

/**
 * `outreach_first_message` pipeline body — opener generation flow used
 * by the campaign dispatcher and the operator's "Start chat" action.
 * Extracted alongside `handleOnInbound` for symmetry; not currently
 * unit-tested (covered by integration with the dispatcher).
 */
export async function handleOutreachFirstMessage(data: { conversationId?: string }): Promise<unknown> {
  const prisma = getPrisma();
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
              campaign: {
                include: {
                  type: { select: { key: true, safetyProfile: true, agentSet: true } },
                },
              },
            },
          });
          if (!conv) throw new Error('conversation not found');

          const safetyExtras = safetyExtrasForCampaign(conv.campaign);

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

          // B2 (agency-sourcing-matching): resolve the opening role via the
          // campaign type's agentSet. For agency_sourcing (behind
          // ENABLE_AGENCY_SOURCING) this maps `opening_composer →
          // agency_opening_composer`, which takes an agency-shaped input
          // (observed_integrations + client_brief). CustDev / flag-off keeps
          // the literal `opening_composer` and its existing input verbatim.
          const openingAgent = resolveRoleAgent(conv.campaign, 'opening_composer', 'opening_composer');
          const openerInput =
            openingAgent === 'agency_opening_composer'
              ? {
                  channel_analysis: contact.channel?.analysis ?? {},
                  contact: buildContactPromptInput(contact),
                  campaign: { goal_text: goalText, client_brief: valueProp },
                  // Recent posts are the only sponsored-integration evidence we
                  // have here; pass them as candidate snippets. The composer's
                  // deterministic no-fabrication guard decides eligibility.
                  observed_integrations: recentPosts.map((p) => ({
                    ...(p.date ? { date: p.date } : {}),
                    snippet: p.text,
                  })),
                }
              : {
                  channel_analysis: contact.channel?.analysis ?? {},
                  contact: buildContactPromptInput(contact),
                  strategy: { approach: 'industry_fit' },
                  campaign: { goal_text: goalText, value_prop: valueProp },
                  recent_posts: recentPosts,
                };
          const opener = await runAgentSafe<OpenerOut>(
            openingAgent,
            openerInput,
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
                ...(safetyExtras
                  ? {
                      forbidden_topics: safetyExtras.forbidden_topics,
                      allowed_topics: safetyExtras.allowed_topics,
                    }
                  : {}),
              },
              {
                conversationId: conv.id,
                ...(safetyExtras ? { overrides: safetyExtras.overrides } : {}),
              },
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

          if (bestSuggestionId && canAutoSendOpening(conv.campaign)) {
            await tryAutoApprove({
              conversationId: conv.id,
              suggestionId: bestSuggestionId,
              text: bestText,
              score: bestScore,
              scheduledAt,
              jitterMaxMs: 2 * 60 * 60 * 1000,
              phase: 'first_touch',
            });
          }

          return { ok: true, suggestions: opener.variants.length };
}

export async function handleFollowupCheck(data: { conversationId?: string }): Promise<unknown> {
  const prisma = getPrisma();
  if (!data.conversationId) throw new Error('conversationId required');
  const conv = await prisma.conversation.findUnique({
    where: { id: data.conversationId },
    include: {
      contact: { include: { channel: true } },
      campaign: {
        select: {
          id: true,
          ajtbd: true,
          goalText: true,
          valueProp: true,
          type: { select: { key: true, safetyProfile: true } },
        },
      },
    },
  });
  if (!conv) throw new Error('conversation not found');
  if (conv.status !== 'active') return { ok: true, skipped: 'not_active' };

  const ajtbd = resolveCampaignAjtbd(conv.campaign);
  const safetyExtras = safetyExtrasForCampaign(conv.campaign);
  const messages = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: 'asc' },
    take: 80,
  });
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'in_');
  const historyTail = messages.slice(-8).map((m) => `${m.direction === 'in_' ? '<<' : '>>'} ${m.text}`);

  if (messages.length > 0 && messages.length % 20 === 0) {
    const summary = await runAgentSafe<{ summary: string }>(
      'conversation_summarizer',
      {
        previous_summary: conv.summary ?? '',
        history: messages.map((m) => ({
          direction: m.direction === 'in_' ? 'in' : 'out',
          sender: m.sender,
          text: m.text,
          at: m.createdAt.toISOString(),
        })),
      },
      { conversationId: conv.id },
    );
    if (summary) {
      await prisma.conversation.update({ where: { id: conv.id }, data: { summary: summary.summary } });
    }
  }

  const plan = await runAgentSafe<NextActionOut>(
    'next_action_planner',
    {
      conversation_state: {
        mode: conv.mode,
        status: conv.status,
        summary: conv.summary ?? '',
        lastInboundAt: conv.lastInboundAt?.toISOString() ?? null,
        lastOutboundAt: conv.lastOutboundAt?.toISOString() ?? null,
        history_tail: historyTail,
      },
      intent_history: [],
      contact_meta: buildContactPromptInput(conv.contact),
    },
    { conversationId: conv.id },
  );
  if (!plan) return { ok: true, degraded: 'next_action_planner_failed' };

  if (plan.next_action === 'close') {
    await prisma.conversation.update({ where: { id: conv.id }, data: { status: 'done' } });
    await publishRealtime(`conversation:${conv.id}`, {
      type: 'status.changed',
      conversationId: conv.id,
      status: 'done',
    });
    return { ok: true, action: 'close' };
  }
  if (plan.next_action === 'escalate') {
    await prisma.conversation.update({ where: { id: conv.id }, data: { mode: 'manual' } });
    await publishRealtime(`conversation:${conv.id}`, {
      type: 'mode.changed',
      conversationId: conv.id,
      mode: 'manual',
    });
    return { ok: true, action: 'escalate' };
  }
  if (plan.next_action === 'wait_hours') return { ok: true, action: 'wait_hours' };

  const existingPending = await prisma.suggestion.count({
    where: {
      conversationId: conv.id,
      agentName: 'reply_composer',
      status: 'pending',
    },
  });
  if (existingPending > 0) {
    return { ok: true, action: plan.next_action, skipped: 'pending_suggestion_exists' };
  }

  const reply = await runAgentSafe<ReplyComposerOut>(
    'reply_composer',
    {
      channel_analysis: conv.contact.channel?.analysis ?? {},
      contact: buildContactPromptInput(conv.contact),
      campaign: {
        goal_text: conv.campaign?.goalText ?? '',
        value_prop: conv.campaign?.valueProp ?? '',
      },
      ...(ajtbd ? { ajtbd } : {}),
      conversation_summary: conv.summary ?? '',
      conversation_history: messages.map((m) => ({
        direction: m.direction === 'in_' ? 'in' : 'out',
        sender: m.sender,
        text: m.text,
        at: m.createdAt.toISOString(),
      })),
      last_inbound: {
        text: lastInbound?.text ?? '',
        intent: 'silence_likely',
        sentiment: 'neutral',
      },
    },
    { conversationId: conv.id },
  );
  if (!reply) return { ok: true, degraded: 'reply_composer_failed' };

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
        ...(safetyExtras
          ? {
              forbidden_topics: safetyExtras.forbidden_topics,
              allowed_topics: safetyExtras.allowed_topics,
            }
          : {}),
        ajtbd_non_goals: ajtbd?.non_goals ?? [],
      },
      {
        conversationId: conv.id,
        ...(safetyExtras ? { overrides: safetyExtras.overrides } : {}),
      },
    );
    if (!safety?.allow) continue;
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

  let gate: GateOut | null = null;
  if (bestSuggestionId && (conv.mode === 'semi_auto' || conv.mode === 'auto') && ajtbd) {
    const previous = readPriorQualityDecision(conv.qualityDecision);
    gate = await runAgentSafe<GateOut>(
      'goal_fit_evaluator',
      {
        ajtbd,
        history_tail: historyTail.slice(-8),
        intent: { intent: 'silence_likely', confidence: 0.6 },
        handoff: { action: 'ai_continue', reason: 'followup_check' },
        draft: bestText,
        previous_decision: previous,
      },
      { conversationId: conv.id },
    );
    if (gate) {
      const decidedAt = new Date().toISOString();
      const flip = conv.mode === 'auto' && shouldFlipOnHandoff(gate, previous);
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          qualityDecision: {
            score: gate.score,
            action: gate.action,
            reasons: gate.reasons,
            decidedAt,
          },
          ...(flip ? { mode: 'assisted' } : {}),
        },
      });
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
        return { ok: true, action: plan.next_action, gate: gate.action, flipped: true };
      }
    }
  }

  if (bestSuggestionId) {
    await tryAutoApprove({
      conversationId: conv.id,
      suggestionId: bestSuggestionId,
      text: bestText,
      score: bestScore,
      scheduledAt: plan.next_action === 'send_followup_at' ? plan.scheduled_at : undefined,
      phase: 'reply',
      ...(gate ? { gate: { action: gate.action, score: gate.score } } : {}),
    });
  }
  return { ok: true, action: plan.next_action };
}

export async function handleQualityReview(data: { conversationId?: string }): Promise<unknown> {
  const prisma = getPrisma();
  if (!data.conversationId) throw new Error('conversationId required');
  const conv = await prisma.conversation.findUnique({
    where: { id: data.conversationId },
    include: { contact: { include: { channel: true } } },
  });
  if (!conv) throw new Error('conversation not found');
  const messages = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: 'asc' },
    take: 80,
  });
  const draft = [...messages].reverse().find((m) => m.direction === 'out_')?.text;
  if (!draft) return { ok: true, skipped: 'no_outbound' };
  const result = await runAgentSafe(
    'quality_reviewer',
    {
      draft,
      conversation_history: messages.map((m) => ({
        direction: m.direction === 'in_' ? 'in' : 'out',
        sender: m.sender,
        text: m.text,
      })),
      channel_analysis: conv.contact.channel?.analysis ?? {},
      contact: buildContactPromptInput(conv.contact),
    },
    { conversationId: conv.id },
  );
  return { ok: true, output: result };
}

export function startAgentRunWorker() {
  const worker = new Worker(
    QueueNames.agentRun,
    async (job) => {
      const data = AgentRunJobZ.parse(job.data);
      switch (data.pipeline) {
        case 'on_inbound':
          return handleOnInbound(data);
        case 'outreach_first_message':
          return handleOutreachFirstMessage(data);
        case 'followup_check':
          return handleFollowupCheck(data);
        case 'quality_review':
          return handleQualityReview(data);
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
