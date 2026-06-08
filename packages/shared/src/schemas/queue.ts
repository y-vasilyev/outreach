import { z } from 'zod';

export const QueueNames = {
  channelScrape: 'channel-scrape',
  contactExtract: 'contact-extract',
  tgSend: 'tg-send',
  tgListen: 'tg-listen',
  agentRun: 'agent-run',
  followupCron: 'followup-cron',
  metricsRoll: 'metrics-roll',
  profileExtract: 'profile-extract',
  discoveryBatch: 'discovery-batch',
  guidedDiscovery: 'guided-discovery',
  guidedDiscoveryReview: 'guided-discovery-review',
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

export const ChannelScrapeJobZ = z.object({
  channelId: z.string(),
});

export const ContactExtractJobZ = z.object({
  channelId: z.string(),
});

export const TgSendJobZ = z.object({
  messageId: z.string(),
  conversationId: z.string(),
  tgAccountId: z.string(),
});

export const TgListenJobZ = z.object({
  tgAccountId: z.string(),
  fromTgUserId: z.string(),
  text: z.string(),
  tgMsgId: z.string(),
  receivedAt: z.string(),
  // Sender profile pulled off the GramJS NewMessage event (often present
  // because the Updates envelope ships the user entity inline). The
  // tg-listen worker uses these to back-fill contacts that were
  // outreached before resolve-on-send landed, without the failure-prone
  // `users.GetUsers` round-trip (no access_hash → resolveUser throws).
  fromUsername: z.string().optional(),
  fromFirstName: z.string().optional(),
  fromLastName: z.string().optional(),
  // GramJS access_hash off the inline sender entity — persisted on the
  // Contact so we can build InputPeerUser explicitly later (sync/read-ack).
  fromAccessHash: z.string().optional(),
  // Lightweight media metadata when the inbound carried a photo/document
  // (agency-sourcing-matching M6). The listener does NOT download bytes; the
  // worker records a media_asset row from this (behind ENABLE_OBJECT_STORAGE).
  media: z
    .object({
      className: z.string(),
      kind: z.enum(['image', 'video', 'document', 'other']),
      mime: z.string().optional(),
      bytes: z.number().int().nonnegative().optional(),
      fileName: z.string().optional(),
    })
    .optional(),
});

export const AgentRunJobZ = z.object({
  pipeline: z.enum([
    'extract_contacts',
    'outreach_first_message',
    'on_inbound',
    'followup_check',
    'quality_review',
  ]),
  channelId: z.string().optional(),
  contactId: z.string().optional(),
  conversationId: z.string().optional(),
  campaignId: z.string().optional(),
});

export const DiscoveryBatchJobZ = z.object({
  /** The `DiscoveryBatch.id` to process. */
  batchId: z.string(),
});

export const GuidedDiscoveryJobZ = z.object({
  /** The `DiscoveryRun.id` to process (ajtbd-guided-blogger-discovery). */
  runId: z.string(),
});

/**
 * Per-candidate review step of the guided-discovery evidence loop
 * (fix-guided-discovery-evidence-loop). Triggered by the `channel-scrape`
 * success/failure hook (one job per open candidate of the scraped channel),
 * the `scrape_refresh` re-arm, or a bounded sweep that closes a wedged run.
 */
export const GuidedDiscoveryReviewJobZ = z.object({
  /** The `DiscoveryRun.id` the candidate(s) belong to. */
  runId: z.string(),
  /** The `DiscoveryRunCandidate.id` to review. Absent for a sweep job. */
  candidateId: z.string().optional(),
  /** Outcome of the scrape that triggered this review (drives no-LLM failure). */
  scrapeOutcome: z.enum(['ok', 'failed']).optional(),
  /** When true, force-close all still-open candidates (deadline sweep). */
  sweep: z.boolean().optional(),
});

export const ProfileExtractJobZ = z.object({
  /** The conversation whose latest inbound triggered extraction. */
  conversationId: z.string(),
  /**
   * Optional explicit inbound message id to attribute data points to. When
   * absent the worker resolves the latest inbound message of the conversation.
   */
  sourceMessageId: z.string().optional(),
  /**
   * Operator re-run (operator-reanalyze-and-markup): when true, the worker
   * deletes the prior rows for this (profileId, sourceMessageId) — after
   * successful extraction, inside the write transaction — before writing the
   * fresh ones, so a re-run replaces stale rows instead of being skipped by
   * write idempotency. Never set for the normal on_inbound path.
   */
  supersede: z.boolean().optional(),
});

export type ChannelScrapeJob = z.infer<typeof ChannelScrapeJobZ>;
export type DiscoveryBatchJob = z.infer<typeof DiscoveryBatchJobZ>;
export type GuidedDiscoveryJob = z.infer<typeof GuidedDiscoveryJobZ>;
export type GuidedDiscoveryReviewJob = z.infer<typeof GuidedDiscoveryReviewJobZ>;
export type ProfileExtractJob = z.infer<typeof ProfileExtractJobZ>;
export type ContactExtractJob = z.infer<typeof ContactExtractJobZ>;
export type TgSendJob = z.infer<typeof TgSendJobZ>;
export type TgListenJob = z.infer<typeof TgListenJobZ>;
export type AgentRunJob = z.infer<typeof AgentRunJobZ>;
