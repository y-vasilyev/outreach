import type {
  ConversationMode,
  ConversationStatus,
  MessageDirection,
  MessageSender,
  SuggestionStatus,
} from './types/index.js';

export type RealtimeRoom =
  | `conversation:${string}`
  | `channel:${string}`
  | `campaign:${string}`
  | `operator:${string}`
  | 'admin:dashboard';

export interface MessageEvent {
  type: 'message.new';
  conversationId: string;
  message: {
    id: string;
    direction: MessageDirection;
    sender: MessageSender;
    text: string;
    createdAt: string;
  };
}

export interface SuggestionEvent {
  type: 'suggestion.new';
  conversationId: string;
  suggestion: {
    id: string;
    agentName: string;
    text: string;
    rationale: string;
    score: number;
    status: SuggestionStatus;
    createdAt: string;
  };
}

export interface StatusChangedEvent {
  type: 'status.changed';
  conversationId: string;
  status: ConversationStatus;
}

export interface ModeChangedEvent {
  type: 'mode.changed';
  conversationId: string;
  mode: ConversationMode;
}

export interface ChannelProgressEvent {
  type: 'channel.progress';
  channelId: string;
  status: string;
  detail?: string;
}

export interface CampaignTickEvent {
  type: 'campaign.tick';
  campaignId: string;
  contactsQueued: number;
  contactsSent: number;
}

export interface DashboardEvent {
  type: 'dashboard.update';
  payload: Record<string, unknown>;
}

export interface OperatorAssignmentEvent {
  type: 'operator.assigned';
  conversationId: string;
  reason: string;
  urgency: 'low' | 'normal' | 'high';
}

export type RealtimeEvent =
  | MessageEvent
  | SuggestionEvent
  | StatusChangedEvent
  | ModeChangedEvent
  | ChannelProgressEvent
  | CampaignTickEvent
  | DashboardEvent
  | OperatorAssignmentEvent;
