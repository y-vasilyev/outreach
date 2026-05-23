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

/**
 * Emitted when an agent in a conversation pipeline fails and the runtime
 * degrades the conversation into `assisted` mode (per CLAUDE.md "Не ронять
 * оператору диалог"). The UI uses this to show a banner with the agent
 * name and reason so the operator knows why suggestions are missing.
 */
export interface AgentFailedEvent {
  type: 'agent.failed';
  conversationId: string;
  agentName: string;
  /** Error code from AppError when known (LLM_SCHEMA_FAILED, LLM_TRANSIENT, …). */
  code?: string;
  /** Short, operator-readable reason. */
  reason: string;
}

/**
 * Emitted when a suggestion is approved (manually by the operator OR
 * automatically by `tryAutoApprove` in auto-mode conversations). The UI
 * uses it to flip the suggestion's row from `pending` to `approved`
 * without waiting for the next refetch.
 */
export interface SuggestionApprovedEvent {
  type: 'suggestion.approved';
  conversationId: string;
  suggestionId: string;
  /** True when the runtime approved without an operator click. */
  auto?: boolean;
}

/**
 * Emitted by the on_inbound pipeline whenever the GoalFitEvaluator gate
 * produces a decision in `semi_auto` / `auto` conversations. Operator
 * UI uses it to surface the latest goal-fit verdict (banner +
 * "AI handed off" indicator) without polling.
 *
 * **Routing**: this event is published only to the operator-side
 * realtime channel(s) for the conversation. It must NOT reach any
 * contact-facing surface — the silent-fallback contract requires the
 * contact to perceive nothing when the AI hands off.
 */
export interface QualityGateEvent {
  type: 'quality.gate';
  conversationId: string;
  score: number;
  action: 'continue' | 'soften' | 'handoff_silent';
  reasons: string[];
  decidedAt: string;
}

export type RealtimeEvent =
  | MessageEvent
  | SuggestionEvent
  | SuggestionApprovedEvent
  | StatusChangedEvent
  | ModeChangedEvent
  | ChannelProgressEvent
  | CampaignTickEvent
  | DashboardEvent
  | OperatorAssignmentEvent
  | AgentFailedEvent
  | QualityGateEvent;
