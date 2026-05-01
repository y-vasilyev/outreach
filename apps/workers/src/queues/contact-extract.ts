import { Worker } from 'bullmq';
import { getRedis } from '../redis.js';
import { ContactExtractJobZ, QueueNames } from '@nosquare/shared';
import { getPrisma } from '@nosquare/db';
import { runRegexCandidates, inferDenyReason } from '@nosquare/agents';
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

      // 2. Regex pre-candidates with deterministic role/deny annotations.
      const text = [ch.description ?? '', postsText, ...(ch.links ?? [])].join('\n');
      const channelHandle = ch.handle.replace(/^@/, '').toLowerCase();
      const allCandidates = runRegexCandidates(text, { channelHandle });

      // Pre-LLM filter: drop candidates with a deny_reason. Logging the
      // dropped ones makes it easy to tune the deny-list as the corpus
      // grows. Self-handle and regulator domains are the most common.
      const denied = allCandidates.filter((c) => c.deny_reason);
      const candidates = allCandidates.filter((c) => !c.deny_reason);
      if (denied.length > 0) {
        logger.info(
          {
            channelId,
            denied: denied.map((c) => ({
              type: c.type,
              value: c.raw_value,
              reason: c.deny_reason,
            })),
          },
          'contact-extract: dropped junk candidates pre-LLM',
        );
      }

      // 3. Contact extraction (LLM)
      let extracted: ContactExtractorOut = { contacts: [] };
      try {
        extracted = await runner.run<ContactExtractorOut>('contact_extractor', {
          platform: ch.platform,
          channel_title: ch.title ?? ch.handle,
          channel_handle: channelHandle,
          description: ch.description,
          links: ch.links,
          recent_posts_text: postsText,
          regex_candidates: candidates,
        }, { channelId });
      } catch (e) {
        // Fallback: at least save regex candidates as low-confidence,
        // using the deterministic role_hint (better than 'unknown').
        logger.warn({ channelId, err: (e as Error).message }, 'contact_extractor failed; using regex only');
        extracted = {
          contacts: candidates.map((c) => ({
            type: mapContactType(c.type),
            value: c.raw_value.replace(/^@/, '').replace(/^https?:\/\//, ''),
            raw_value: c.raw_value,
            role_guess: c.role_hint,
            confidence: c.role_hint === 'unknown' ? 0.25 : 0.45,
            rationale: `regex-only fallback (role_hint=${c.role_hint})`,
          })),
        };
      }

      // Post-LLM filter: even with the new prompt, models occasionally
      // "rescue" denied candidates by re-listing them (especially the
      // channel's own handle). Re-apply the deny rules on each LLM output.
      const beforeFilter = extracted.contacts.length;
      extracted.contacts = extracted.contacts.filter((c) => {
        const value = (c.value || c.raw_value || '').toLowerCase();
        // Self-handle catch — covers @value, t.me/value, bare value.
        const handle = value
          .replace(/^@/, '')
          .replace(/^https?:\/\/t\.me\//, '')
          .replace(/^t\.me\//, '');
        if (channelHandle && handle === channelHandle) {
          logger.info({ channelId, value }, 'post-filter: dropped self-handle');
          return false;
        }
        // Regulator/payment/etc. domains. Synthesise a snippet from rationale
        // so the same inferDenyReason works on LLM output as on regex output.
        const reason = inferDenyReason(
          // Map back to RegexCandidateType (web_form → website for filter purposes).
          c.type === 'web_form' ? 'website' : (c.type as 'tg_username' | 'tg_link' | 'email' | 'phone' | 'website' | 'other'),
          c.raw_value || c.value,
          c.rationale ?? '',
          channelHandle,
        );
        if (reason) {
          logger.info({ channelId, value, reason }, 'post-filter: dropped LLM contact');
          return false;
        }
        return true;
      });
      if (extracted.contacts.length !== beforeFilter) {
        logger.info(
          { channelId, before: beforeFilter, after: extracted.contacts.length },
          'contact-extract: post-LLM filter removed contacts',
        );
      }

      // 4. Persist contacts
      // Pre-load existing rows so we can detect operator overrides
      // (`extractedBy === 'manual'`) and skip overwriting them on re-run.
      const existing = await prisma.contact.findMany({
        where: { channelId },
        select: { type: true, value: true, extractedBy: true },
      });
      const manualKeys = new Set(
        existing
          .filter((e) => e.extractedBy === 'manual')
          .map((e) => `${e.type}:${e.value}`),
      );

      let saved = 0;
      let preservedManual = 0;
      for (const c of extracted.contacts) {
        const value = c.value.trim();
        if (!value) continue;
        const type = mapContactType(c.type);
        if (manualKeys.has(`${type}:${value}`)) {
          // Operator already corrected this row; don't clobber.
          preservedManual += 1;
          continue;
        }
        const reachability =
          type === 'tg_username' || type === 'tg_link' ? 'reachable_tg' : 'manual';
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
      if (preservedManual > 0) {
        logger.info(
          { channelId, preservedManual },
          'preserved manual contact overrides during re-extract',
        );
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
