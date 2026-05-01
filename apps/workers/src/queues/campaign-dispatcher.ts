import type { Prisma } from '@nosquare/db';
import { getPrisma } from '@nosquare/db';
import { type CampaignSchedule, isWithinSchedule } from '@nosquare/shared';
import { getRunner } from '../services/runner.js';
import { logger } from '../logger.js';
import { tryAutoApprove } from '../services/auto-approve.js';
import { buildContactPromptInput } from '../services/agent-input.js';

interface OpenerOut {
  variants: Array<{ text: string; rationale: string; risk_score: number }>;
}
interface SafetyOut {
  allow: boolean;
  risk_score: number;
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
      const campaigns = await prisma.campaign.findMany({ where: { status: 'running' } });

      for (const c of campaigns) {
        const schedule = (c.schedule ?? {}) as CampaignSchedule;
        if (!isWithinSchedule(schedule)) {
          logger.debug({ campaignId: c.id }, 'campaign outside schedule window; skipping tick');
          continue;
        }

        const filter = c.targetFilter as {
          platforms?: string[];
          roleGuess?: string[];
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
        // Physical reachability (`reachable_tg`), platform restriction
        // and "no existing convo for this campaign" apply to BOTH.
        const where: Prisma.ContactWhereInput = {
          reachability: 'reachable_tg',
          ...(filter.platforms && filter.platforms.length > 0
            ? { channel: { platform: { in: filter.platforms as never[] } } }
            : {}),
          conversations: { none: { campaignId: c.id } },
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

        const accounts = await prisma.tgAccount.findMany({
          where: { id: { in: c.outreachAccountPool }, status: 'active' },
        });
        if (accounts.length === 0) continue;

        accounts.sort((a, b) => a.sentTodayMsg - b.sentTodayMsg);

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
          // messages — the candidate filter at line 81 is keyed on
          // campaignId, so a contact with a *campaignId=null* (manually-
          // started chat) or a different-campaign conversation can still
          // make it here, and the upsert above will rebind it to this
          // campaign. Without this guard the operator sees opening_composer
          // suggestions popping up in the middle of an ongoing chat.
          const existingMsgs = await prisma.message.count({
            where: { conversationId: conv.id },
          });
          if (existingMsgs > 0) {
            logger.debug(
              { conversationId: conv.id, contactId: contact.id, campaignId: c.id },
              'campaign-dispatcher: conversation already has messages; skipping opener',
            );
            continue;
          }

          // Pull recent posts for the "one concrete hook" prompt rule —
          // without them the LLM falls back to generic openings.
          const rawPosts =
            ((contact.channel?.rawData as
              | { posts?: { text?: string; date?: string }[] }
              | null
              | undefined)?.posts ?? []).slice(0, 5);
          const recentPosts = rawPosts.map((p) => ({
            ...(p.date ? { date: p.date } : {}),
            text: p.text ?? '',
          }));

          try {
            const opener = await runner.run<OpenerOut>('opening_composer', {
              channel_analysis: contact.channel?.analysis ?? {},
              contact: buildContactPromptInput(contact),
              strategy: { approach: 'industry_fit' },
              campaign: { goal_text: c.goalText, value_prop: c.valueProp },
              recent_posts: recentPosts,
            }, { conversationId: conv.id, campaignId: c.id, contactId: contact.id });

            // Track the highest-scoring variant after the safety loop, so
            // auto-approve sends the BEST one rather than the first to
            // pass safety.
            let bestSuggestionId: string | null = null;
            let bestScore = 0;
            let bestText = '';

            for (const v of opener.variants) {
              const safety = await runner.run<SafetyOut>('safety_filter', {
                draft: v.text,
                channel_analysis: contact.channel?.analysis ?? {},
                contact: { id: contact.id },
                campaign: { name: c.name },
              }, { conversationId: conv.id });
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
              if (score > bestScore) {
                bestScore = score;
                bestSuggestionId = sug.id;
                bestText = v.text;
              }
            }

            await prisma.contact.update({
              where: { id: contact.id },
              data: { status: 'contacted' },
            });

            // Auto-mode: when the conversation is `auto`-mode and the top
            // suggestion is high-confidence + low-risk, send it without
            // waiting for an operator click.
            if (bestSuggestionId) {
              await tryAutoApprove({
                conversationId: conv.id,
                suggestionId: bestSuggestionId,
                text: bestText,
                score: bestScore,
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
