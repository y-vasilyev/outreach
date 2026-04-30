import type { Prisma } from '@nosquare/db';
import { getPrisma } from '@nosquare/db';
import { getRunner } from '../services/runner.js';
import { logger } from '../logger.js';
import { tryAutoApprove } from '../services/auto-approve.js';

interface OpenerOut {
  variants: Array<{ text: string; rationale: string; risk_score: number }>;
}
interface SafetyOut {
  allow: boolean;
  risk_score: number;
}

interface CampaignSchedule {
  tz?: string;
  workHours?: { start?: string; end?: string };
  /** ISO weekday numbers; 0=Sun..6=Sat to match `Date.getDay()`. */
  days?: number[];
  maxPerDayPerAccount?: number;
}

const DISPATCH_INTERVAL_MS = 30_000;

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

        const where: Prisma.ContactWhereInput = {
          status: 'qualified',
          reachability: 'reachable_tg',
          ...(filter.roleGuess && filter.roleGuess.length > 0
            ? { roleGuess: { in: filter.roleGuess as never[] } }
            : {}),
          ...(filter.minConfidence
            ? { confidence: { gte: filter.minConfidence } }
            : {}),
          ...(filter.platforms && filter.platforms.length > 0
            ? { channel: { platform: { in: filter.platforms as never[] } } }
            : {}),
          ...(filter.tags && filter.tags.length > 0
            ? { tags: { hasSome: filter.tags } }
            : {}),
          conversations: { none: { campaignId: c.id } },
        };

        const candidates = await prisma.contact.findMany({
          where,
          include: { channel: true },
          take: 5,
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

          try {
            const opener = await runner.run<OpenerOut>('opening_composer', {
              channel_analysis: contact.channel?.analysis ?? {},
              contact: { value: contact.value, role: contact.roleGuess, type: contact.type },
              strategy: { approach: 'industry_fit' },
              campaign: { goal_text: c.goalText, value_prop: c.valueProp },
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

/**
 * Returns true when the current wall-clock time falls inside `schedule.days`
 * AND `schedule.workHours`, both interpreted in `schedule.tz`.
 *
 * Missing fields = "no constraint": an empty schedule means "always on"
 * (preserves the prior behaviour for unscheduled campaigns). Time strings
 * must be `HH:MM` 24-hour format.
 *
 * Time-zone resolution uses `Intl.DateTimeFormat` with a numeric hour/minute
 * formatter — no third-party tz library needed.
 */
function isWithinSchedule(s: CampaignSchedule): boolean {
  const tz = s.tz || 'UTC';
  const now = new Date();

  if (Array.isArray(s.days) && s.days.length > 0) {
    const dayName = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: tz,
    }).format(now);
    const map: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const wd = map[dayName] ?? -1;
    if (!s.days.includes(wd)) return false;
  }

  if (s.workHours?.start && s.workHours.end) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    });
    const parts = fmt.formatToParts(now);
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const cur = `${h}:${m}`;
    if (cur < s.workHours.start || cur >= s.workHours.end) return false;
  }
  return true;
}
