import { Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import { ContactExtractJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { runRegexCandidates } from '@nosquare/agents';
import { getRunner } from '../services/runner.js';
import { logger } from '../logger.js';
import { publishRealtime } from '../services/realtime-emit.js';

interface ChannelAnalysisOut {
  language?: string;
  topic?: string;
  audience?: string;
  format?: string;
  tone?: string;
  owner_signals?: { is_personal_brand: boolean; owner_hint?: string };
  red_flags?: string[];
}

interface ContactExtractorOut {
  contacts: Array<{
    type:
      | 'tg_username'
      | 'tg_link'
      | 'tg_phone'
      | 'email'
      | 'phone'
      | 'website'
      | 'web_form'
      | 'other';
    value: string;
    raw_value: string;
    role_guess: 'owner' | 'ad_manager' | 'generic' | 'bot' | 'unknown';
    label?: string;
    confidence: number;
    rationale: string;
  }>;
  no_contacts_reason?: string;
}

function mapContactType(t: string): 'tg_username' | 'tg_phone' | 'tg_link' | 'email' | 'website' | 'web_form' | 'other' {
  switch (t) {
    case 'tg_username':
    case 'tg_phone':
    case 'tg_link':
    case 'email':
    case 'website':
    case 'web_form':
    case 'other':
      return t;
    case 'phone':
      return 'tg_phone';
    default:
      return 'other';
  }
}

export function startContactExtractWorker() {
  const worker = new Worker(
    QueueNames.contactExtract,
    async (job) => {
      const { channelId } = ContactExtractJobZ.parse(job.data);
      const prisma = getPrisma();
      const ch = await prisma.channel.findUnique({ where: { id: channelId } });
      if (!ch) throw new Error(`channel ${channelId} not found`);
      if (!ch.description) {
        await prisma.channel.update({
          where: { id: channelId },
          data: { status: 'extracted', analysis: { red_flags: ['no description'] } },
        });
        return { ok: true, contacts: 0 };
      }

      await prisma.channel.update({ where: { id: channelId }, data: { status: 'extracting' } });
      await publishRealtime(`channel:${channelId}`, {
        type: 'channel.progress',
        channelId,
        status: 'extracting',
      });

      const runner = getRunner();

      const recentPosts = (ch.rawData as { posts?: { text: string; date?: string }[] } | null)
        ?.posts ?? [];
      const postsText = recentPosts
        .slice(0, 10)
        .map((p) => p.text ?? '')
        .filter(Boolean)
        .join('\n---\n');

      // 1. Channel analysis
      let analysis: ChannelAnalysisOut = {};
      try {
        analysis = await runner.run<ChannelAnalysisOut>('channel_analyzer', {
          platform: ch.platform,
          title: ch.title ?? ch.handle,
          description: ch.description,
          links: ch.links,
          followers: ch.followers,
          recent_posts: recentPosts,
        }, { channelId });
      } catch (e) {
        logger.warn({ channelId, err: (e as Error).message }, 'channel_analyzer failed; continuing');
      }

      // 2. Regex pre-candidates
      const text = [ch.description ?? '', postsText, ...(ch.links ?? [])].join('\n');
      const candidates = runRegexCandidates(text);

      // 3. Contact extraction (LLM)
      let extracted: ContactExtractorOut = { contacts: [] };
      try {
        extracted = await runner.run<ContactExtractorOut>('contact_extractor', {
          platform: ch.platform,
          channel_title: ch.title ?? ch.handle,
          description: ch.description,
          links: ch.links,
          recent_posts_text: postsText,
          regex_candidates: candidates,
        }, { channelId });
      } catch (e) {
        // Fallback: at least save regex candidates as low-confidence
        logger.warn({ channelId, err: (e as Error).message }, 'contact_extractor failed; using regex only');
        extracted = {
          contacts: candidates.map((c) => ({
            type: mapContactType(c.type),
            value: c.raw_value.replace(/^@/, '').replace(/^https?:\/\//, ''),
            raw_value: c.raw_value,
            role_guess: 'unknown' as const,
            confidence: 0.3,
            rationale: 'regex-only fallback',
          })),
        };
      }

      // 4. Persist contacts
      let saved = 0;
      for (const c of extracted.contacts) {
        const value = c.value.trim();
        if (!value) continue;
        const type = mapContactType(c.type);
        const reachability = type === 'tg_username' || type === 'tg_link' ? 'reachable_tg' : 'manual';
        try {
          await prisma.contact.upsert({
            where: { channelId_type_value: { channelId, type, value } },
            update: {
              roleGuess: c.role_guess,
              confidence: c.confidence,
              rawValue: c.raw_value,
              extractedBy: 'both',
            },
            create: {
              channelId,
              type,
              value,
              rawValue: c.raw_value,
              label: c.label ?? null,
              roleGuess: c.role_guess,
              confidence: c.confidence,
              extractedBy: 'both',
              reachability,
              status: c.confidence >= 0.4 ? 'qualified' : 'new',
            },
          });
          saved += 1;
        } catch (e) {
          logger.warn({ channelId, value, err: (e as Error).message }, 'contact upsert failed');
        }
      }

      const redFlags = analysis.red_flags ?? [];
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          analysis: analysis as object,
          status: redFlags.length > 0 ? 'failed' : 'extracted',
          lastError: redFlags.length > 0 ? `red_flags: ${redFlags.join(', ')}` : null,
        },
      });

      await publishRealtime(`channel:${channelId}`, {
        type: 'channel.progress',
        channelId,
        status: 'extracted',
        detail: `${saved} contacts`,
      });

      return { ok: true, contacts: saved };
    },
    { connection: getRedis(), concurrency: 2 },
  );

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err?.message }, 'contact-extract failed'),
  );
  return worker;
}
