import { getPrisma, type Prisma } from '@nosquare/db';
import { getFeatureFlags } from '../feature-flags.js';
import {
  type CampaignSchedule,
  isWithinSchedule,
  resolveAgentName,
  resolveSafetyContext,
} from '@nosquare/shared';
import { getRunner } from '../services/runner.js';
import { logger } from '../logger.js';
import { tryAutoApprove } from '../services/auto-approve.js';
import { buildContactPromptInput } from '../services/agent-input.js';
import { ensureContactTgProfile } from '../services/contact-profile.js';
import { rolloverTgAccountDailyCounters } from '../services/tg-account-limits.js';

interface OpenerOut {
  // `variantKey` is populated by the composer's deterministic post-process
  // (`assignVariantKeys`) — always non-empty (alphabetical fallback when the
  // LLM doesn't supply a semantic key). Used downstream to attribute the
  // outbound message to a specific opener variant (ab-opener-variants).
  variants: Array<{ text: string; rationale: string; risk_score: number; variantKey: string }>;
}
interface SafetyOut {
  allow: boolean;
  risk_score: number;
}

/**
 * Resolve the agent_config name for a pipeline role given the campaign's type
 * (B4, agency-sourcing-matching). Mirrors `resolveRoleAgent` in agent-run.ts:
 * behind ENABLE_AGENCY_SOURCING, an `agency_sourcing` campaign maps roles via
 * the type's `agentSet` (e.g. `opening_composer → agency_opening_composer`).
 * Flag off / non-agency type / no type → returns the literal `fallback`, so the
 * CustDev dispatch path stays byte-for-byte on the legacy global agent names.
 */
function resolveRoleAgent(
  campaign:
    | { type?: { key?: string | null; agentSet?: unknown } | null }
    | null
    | undefined,
  role: string,
  fallback: string,
): string {
  if (!getFeatureFlags().get('agency_sourcing')) return fallback;
  if (campaign?.type?.key !== 'agency_sourcing') return fallback;
  return resolveAgentName(campaign.type.agentSet ?? null, role, fallback);
}

// Tick every 10s (was 30) so a campaign that gets a fresh batch of
// contacts via "В кампанию" reaches the operator within a minute even
// for sizeable batches. Each tick still takes only `take` contacts so
// the per-tick load stays bounded.
const DISPATCH_INTERVAL_MS = 10_000;

/**
 * Lightweight campaign dispatcher: every N seconds picks up to K qualified
 * contacts for each running campaign whose target filter matches, creates a
 * conversation with the least-loaded outreach account from the pool,
 * generates opener suggestions, and either:
 *   - leaves them as `pending` for the operator (assisted/manual modes), or
 *   - auto-sends the top one when conv.mode === 'auto' and SafetyFilter is
 *     happy (`tryAutoApprove`).
 *
 * Schedule (`campaign.schedule`) is honoured: outside `workHours` or on
 * disallowed weekdays the campaign tick is skipped silently.
 */
export function startCampaignDispatcher() {
  let stopping = false;

  const tick = async () => {
    if (stopping) return;
    try {
      const prisma = getPrisma();
      const campaigns = await prisma.campaign.findMany({
        where: { status: 'running' },
        // B4: load the campaign type so opener/safety roles resolve via the
        // type's agentSet for agency_sourcing campaigns (behind the flag).
        // The `include` is additive; CustDev campaigns simply have type=null.
        include: { type: { select: { key: true, agentSet: true, safetyProfile: true } } },
      });

      for (const c of campaigns) {
        const schedule = (c.schedule ?? {}) as CampaignSchedule;
        if (!isWithinSchedule(schedule)) {
          logger.debug({ campaignId: c.id }, 'campaign outside schedule window; skipping tick');
          continue;
        }

        const filter = c.targetFilter as {
          platforms?: string[];
          roleGuess?: string[];
          languages?: string[];
          topics?: string[];
          minConfidence?: number;
          /**
           * Tags act as a narrowing filter: a contact must have at least one
           * of these tags. Operators add `cmp:<campaignId>` via the "В
           * кампанию" UI; without `hasSome` here that bridge is dead.
           */
          tags?: string[];
        };

        // The campaign-specific tag stamped by `addContacts` whenever an
        // operator explicitly drops contacts into this campaign.
        const manualTag = `cmp:${c.id}`;
        const otherTags = (filter.tags ?? []).filter((t) => t !== manualTag);

        // Two acceptance branches OR'd together:
        //   manual: operator-tagged contacts skip status/roleGuess/
        //     minConfidence — explicit selection wins. Otherwise an
        //     operator who picks an `unknown`-role contact would never
        //     get a chat ("очевидно что хочу написать").
        //   auto:   the existing autonomous discovery filter.
        // Physical reachability (`reachable_tg`) and platform restriction
        // apply to BOTH. A campaign conversation only disqualifies the
        // contact when it already has messages or a usable opening
        // suggestion; a failed/empty opener run should be retried.
        const where: Prisma.ContactWhereInput = {
          reachability: 'reachable_tg',
          ...((filter.platforms && filter.platforms.length > 0) ||
          (filter.languages && filter.languages.length > 0) ||
          (filter.topics && filter.topics.length > 0)
            ? {
                channel: {
                  ...(filter.platforms && filter.platforms.length > 0
                    ? { platform: { in: filter.platforms as never[] } }
                    : {}),
                  ...(filter.languages && filter.languages.length > 0
                    ? { language: { in: filter.languages } }
                    : {}),
                  ...(filter.topics && filter.topics.length > 0
                    ? {
                        OR: filter.topics.flatMap((topic) => [
                          { title: { contains: topic, mode: 'insensitive' as const } },
                          { description: { contains: topic, mode: 'insensitive' as const } },
                          {
                            analysis: {
                              path: ['topic'],
                              string_contains: topic,
                              mode: 'insensitive' as const,
                            },
                          },
                        ]),
                      }
                    : {}),
                },
              }
            : {}),
          conversations: {
            none: {
              campaignId: c.id,
              OR: [
                { messages: { some: {} } },
                {
                  suggestions: {
                    some: {
                      // Match BOTH opener agent names so agency campaigns
                      // don't re-fire on top of an existing
                      // `agency_opening_composer` suggestion (parallel of
                      // the per-conversation guard below). ab-opener-variants.
                      agentName: { in: ['opening_composer', 'agency_opening_composer'] },
                      status: { in: ['pending', 'approved', 'sent'] },
                    },
                  },
                },
              ],
            },
          },
          OR: [
            { tags: { has: manualTag } },
            {
              AND: [
                { status: 'qualified' as const },
                ...(filter.roleGuess && filter.roleGuess.length > 0
                  ? [{ roleGuess: { in: filter.roleGuess as never[] } }]
                  : []),
                ...(filter.minConfidence != null
                  ? [{ confidence: { gte: filter.minConfidence } }]
                  : []),
                ...(otherTags.length > 0 ? [{ tags: { hasSome: otherTags } }] : []),
              ],
            },
          ],
        };

        const candidates = await prisma.contact.findMany({
          where,
          include: { channel: true },
          // Higher take so a "В кампанию" of 50–100 contacts isn't paced
          // out at 5/tick (= many minutes); each conversation still gets
          // its own opener LLM call so this throttles itself naturally.
          take: 25,
          orderBy: { confidence: 'desc' },
        });

        if (candidates.length === 0) continue;
        if (c.outreachAccountPool.length === 0) {
          logger.warn({ campaignId: c.id }, 'campaign has no outreach accounts; skipping');
          continue;
        }

        await rolloverTgAccountDailyCounters(c.outreachAccountPool);
        const accounts = await prisma.tgAccount.findMany({
          where: { id: { in: c.outreachAccountPool }, status: 'active' },
        });
        if (accounts.length === 0) continue;

        accounts.sort(
          (a: { sentTodayMsg: number }, b: { sentTodayMsg: number }) =>
            a.sentTodayMsg - b.sentTodayMsg,
        );

        // Effective daily cap = stricter of per-account `dailyMsgLimit` and
        // per-campaign `schedule.maxPerDayPerAccount`. Either field acts
        // alone if the other is missing.
        const campaignCap = schedule.maxPerDayPerAccount;

        const runner = getRunner();
        for (let i = 0; i < candidates.length; i++) {
          const contact = candidates[i];
          if (!contact) continue;
          const acct = accounts[i % accounts.length];
          if (!acct) continue;
          const cap = campaignCap
            ? Math.min(acct.dailyMsgLimit, campaignCap)
            : acct.dailyMsgLimit;
          if (acct.sentTodayMsg >= cap) continue;

          const conv = await prisma.conversation.upsert({
            where: { tgAccountId_contactId: { tgAccountId: acct.id, contactId: contact.id } },
            update: { campaignId: c.id, mode: c.defaultMode },
            create: {
              tgAccountId: acct.id,
              contactId: contact.id,
              campaignId: c.id,
              status: 'active',
              mode: c.defaultMode,
            },
          });

          // Don't re-run the opener if this conversation already has any
          // messages or a usable opening suggestion. The candidate filter
          // above handles campaign-bound conversations, but the upsert may
          // also bind an older ad-hoc/different-campaign conversation.
          // Match BOTH opener agent names so an agency campaign doesn't
          // re-fire on top of an existing `agency_opening_composer`
          // suggestion (ab-opener-variants change).
          const [existingMsgs, existingOpeningSuggestions] = await Promise.all([
            prisma.message.count({ where: { conversationId: conv.id } }),
            prisma.suggestion.count({
              where: {
                conversationId: conv.id,
                agentName: { in: ['opening_composer', 'agency_opening_composer'] },
                status: { in: ['pending', 'approved', 'sent'] },
              },
            }),
          ]);
          if (existingMsgs > 0 || existingOpeningSuggestions > 0) {
            logger.debug(
              { conversationId: conv.id, contactId: contact.id, campaignId: c.id },
              'campaign-dispatcher: conversation already has opener state; skipping opener',
            );
            continue;
          }

          await ensureContactTgProfile(conv.tgAccountId, contact);
          const contactForPrompt = await prisma.contact.findUnique({
            where: { id: contact.id },
            include: { channel: true },
          });
          if (!contactForPrompt) continue;

          // Pull recent posts for the "one concrete hook" prompt rule —
          // without them the LLM falls back to generic openings.
          const rawPosts =
            ((contactForPrompt.channel?.rawData as
              | { posts?: { text?: string; date?: string }[] }
              | null
              | undefined)?.posts ?? []).slice(0, 5);
          const recentPosts = rawPosts.map((p) => ({
            ...(p.date ? { date: p.date } : {}),
            text: p.text ?? '',
          }));

          // B4: resolve the opening + safety roles via the campaign type.
          // CustDev / flag-off keeps the literal 'opening_composer' /
          // 'safety_filter'. Agency types map opening_composer →
          // agency_opening_composer (agency-shaped input below).
          const openingAgent = resolveRoleAgent(c, 'opening_composer', 'opening_composer');
          const safetyAgent = resolveRoleAgent(c, 'safety_filter', 'safety_filter');
          // safety-filter-hard-block: serialize the type's deterministic
          // hard-block regexes for the SafetyFilter input. Only attached
          // when `campaign_types` is on AND the type has a profile; the
          // legacy/CustDev path passes an empty array (no-op).
          const safetyHardBlocks = getFeatureFlags().get('campaign_types')
            ? resolveSafetyContext(c.type?.safetyProfile ?? null).hard_block_patterns.map(
                (p) => ({
                  id: p.id,
                  pattern: p.regex.source,
                  reason: p.reason,
                  ...(p.regex.flags ? { flags: p.regex.flags } : {}),
                }),
              )
            : [];
          const openerInput =
            openingAgent === 'agency_opening_composer'
              ? {
                  channel_analysis: contactForPrompt.channel?.analysis ?? {},
                  contact: buildContactPromptInput(contactForPrompt),
                  campaign: { goal_text: c.goalText, client_brief: c.valueProp },
                  // Recent posts are the only sponsored-integration evidence we
                  // have at dispatch; pass as candidate snippets. The composer's
                  // no-fabrication guard decides eligibility. Mirrors
                  // handleOutreachFirstMessage in agent-run.ts.
                  observed_integrations: recentPosts.map((p) => ({
                    ...(p.date ? { date: p.date } : {}),
                    snippet: p.text,
                  })),
                }
              : {
                  channel_analysis: contactForPrompt.channel?.analysis ?? {},
                  contact: buildContactPromptInput(contactForPrompt),
                  strategy: { approach: 'industry_fit' },
                  campaign: { goal_text: c.goalText, value_prop: c.valueProp },
                  recent_posts: recentPosts,
                };

          try {
            const opener = await runner.run<OpenerOut>(
              openingAgent,
              openerInput,
              { conversationId: conv.id, campaignId: c.id, contactId: contact.id },
            );

            // Track the highest-scoring variant after the safety loop, so
            // auto-approve sends the BEST one rather than the first to
            // pass safety.
            let bestSuggestionId: string | null = null;
            let bestScore = 0;
            let bestText = '';

            for (const v of opener.variants) {
              const safety = await runner.run<SafetyOut>(safetyAgent, {
                draft: v.text,
                channel_analysis: contactForPrompt.channel?.analysis ?? {},
                contact: { id: contact.id },
                campaign: { name: c.name },
                hard_block_patterns: safetyHardBlocks,
              }, { conversationId: conv.id });
              if (!safety.allow) continue;
              const score = 1 - safety.risk_score;
              const sug = await prisma.suggestion.create({
                data: {
                  conversationId: conv.id,
                  // Persist the actual composer's agent name — CustDev /
                  // flag-off uses 'opening_composer', agency routing uses
                  // 'agency_opening_composer'. Both names are recognised by
                  // `extractOpenerVariant` and counted by the opener-stats
                  // service. ab-opener-variants change.
                  agentName: openingAgent,
                  text: v.text,
                  rationale: v.rationale,
                  score,
                  status: 'pending',
                  // `meta.openerVariant` carries the composer's stable
                  // variantKey through to the outbound `Message.openerVariant`
                  // (set in tryAutoApprove / approveSuggestion). This is what
                  // `GET /campaigns/:id/opener-stats` aggregates over.
                  // See ab-opener-variants change.
                  meta: { openerVariant: v.variantKey },
                },
              });
              if (score > bestScore) {
                bestScore = score;
                bestSuggestionId = sug.id;
                bestText = v.text;
              }
            }

            if (bestSuggestionId) {
              await prisma.contact.update({
                where: { id: contact.id },
                data: { status: 'contacted' },
              });
            }

            // Auto-mode: when the conversation is `auto`-mode and the top
            // suggestion is high-confidence + low-risk, send it without
            // waiting for an operator click.
            if (bestSuggestionId) {
              await tryAutoApprove({
                conversationId: conv.id,
                suggestionId: bestSuggestionId,
                text: bestText,
                score: bestScore,
                jitterMaxMs: 3 * 60 * 60 * 1000,
                phase: 'first_touch',
              });
            }
          } catch (e) {
            logger.warn(
              { campaignId: c.id, contactId: contact.id, err: (e as Error).message },
              'opener generation failed; conversation stays pending',
            );
          }
        }
      }
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'dispatcher tick failed');
    }
  };

  const handle = setInterval(() => void tick(), DISPATCH_INTERVAL_MS);
  return {
    stop: () => {
      stopping = true;
      clearInterval(handle);
    },
  };
}
