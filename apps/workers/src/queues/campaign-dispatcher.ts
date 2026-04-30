import type { Prisma } from '@nosquare/db';
import { getPrisma } from '@nosquare/db';
import { getRunner } from '../services/runner.js';
import { logger } from '../logger.js';

interface OpenerOut {
  variants: Array<{ text: string; rationale: string; risk_score: number }>;
}
interface SafetyOut {
  allow: boolean;
  risk_score: number;
}

const DISPATCH_INTERVAL_MS = 30_000;

/**
 * Lightweight campaign dispatcher: every N seconds picks up to K qualified contacts
 * for each running campaign whose target filter matches, creates a conversation
 * with the least-loaded outreach account from the pool, generates suggestions
 * via outreach_first_message pipeline, and stores them as pending suggestions
 * (auto-mode could auto-send the top one — left as pending for safety).
 */
export function startCampaignDispatcher() {
  let stopping = false;

  const tick = async () => {
    if (stopping) return;
    try {
      const prisma = getPrisma();
      const campaigns = await prisma.campaign.findMany({ where: { status: 'running' } });

      for (const c of campaigns) {
        const filter = c.targetFilter as {
          platforms?: string[];
          roleGuess?: string[];
          minConfidence?: number;
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

        const runner = getRunner();
        for (let i = 0; i < candidates.length; i++) {
          const contact = candidates[i];
          if (!contact) continue;
          const acct = accounts[i % accounts.length];
          if (!acct) continue;
          if (acct.sentTodayMsg >= acct.dailyMsgLimit) continue;

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
              channel_analysis: contact.channel.analysis,
              contact: { value: contact.value, role: contact.roleGuess, type: contact.type },
              strategy: { approach: 'industry_fit' },
              campaign: { goal_text: c.goalText, value_prop: c.valueProp },
            }, { conversationId: conv.id, campaignId: c.id, contactId: contact.id });

            for (const v of opener.variants) {
              const safety = await runner.run<SafetyOut>('safety_filter', {
                draft: v.text,
                channel_analysis: contact.channel.analysis,
                contact: { id: contact.id },
                campaign: { name: c.name },
              }, { conversationId: conv.id });
              if (!safety.allow) continue;
              await prisma.suggestion.create({
                data: {
                  conversationId: conv.id,
                  agentName: 'opening_composer',
                  text: v.text,
                  rationale: v.rationale,
                  score: 1 - safety.risk_score,
                  status: 'pending',
                },
              });
            }
            await prisma.contact.update({
              where: { id: contact.id },
              data: { status: 'contacted' },
            });
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
