import { z } from 'zod';

export const MessageDirectionZ = z.enum(['in', 'out']);
export const MessageSenderZ = z.enum(['contact', 'ai', 'operator', 'system']);
export const MessageStatusZ = z.enum([
  'pending',
  'sending',
  'sent',
  'failed',
  'received',
]);

export const MessageZ = z.object({
  id: z.string(),
  conversationId: z.string(),
  tgMsgId: z.string().nullable(),
  direction: MessageDirectionZ,
  sender: MessageSenderZ,
  text: z.string(),
  status: MessageStatusZ,
  suggestionId: z.string().nullable(),
  operatorId: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});

export const SendMessageInputZ = z.object({
  conversationId: z.string(),
  text: z.string().min(1).max(2000),
  fromSuggestionId: z.string().optional(),
  bypassSafety: z.boolean().default(false),
});

export type Message = z.infer<typeof MessageZ>;
