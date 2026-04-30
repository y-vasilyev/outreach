import { z } from 'zod';

export const QueueNames = {
  channelScrape: 'channel-scrape',
  contactExtract: 'contact-extract',
  tgSend: 'tg-send',
  tgListen: 'tg-listen',
  agentRun: 'agent-run',
  followupCron: 'followup-cron',
  metricsRoll: 'metrics-roll',
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

export type ChannelScrapeJob = z.infer<typeof ChannelScrapeJobZ>;
export type ContactExtractJob = z.infer<typeof ContactExtractJobZ>;
export type TgSendJob = z.infer<typeof TgSendJobZ>;
export type TgListenJob = z.infer<typeof TgListenJobZ>;
export type AgentRunJob = z.infer<typeof AgentRunJobZ>;
