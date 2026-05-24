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

export const ProfileExtractJobZ = z.object({
  /** The conversation whose latest inbound triggered extraction. */
  conversationId: z.string(),
  /**
   * Optional explicit inbound message id to attribute data points to. When
   * absent the worker resolves the latest inbound message of the conversation.
   */
  sourceMessageId: z.string().optional(),
});

export type ChannelScrapeJob = z.infer<typeof ChannelScrapeJobZ>;
export type DiscoveryBatchJob = z.infer<typeof DiscoveryBatchJobZ>;
export type ProfileExtractJob = z.infer<typeof ProfileExtractJobZ>;
export type ContactExtractJob = z.infer<typeof ContactExtractJobZ>;
export type TgSendJob = z.infer<typeof TgSendJobZ>;
export type TgListenJob = z.infer<typeof TgListenJobZ>;
export type AgentRunJob = z.infer<typeof AgentRunJobZ>;
