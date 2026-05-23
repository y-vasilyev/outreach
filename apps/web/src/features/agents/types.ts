export interface AgentEndpointRef {
  id: string;
  name: string;
  provider?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  role?: string;
  description?: string;
  endpoint?: AgentEndpointRef;
  fallbackEndpoint?: AgentEndpointRef | null;
  model: string;
  enabled: boolean;
  version: number;
  variables?: string[];
  updatedAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  role?: string;
  description?: string;
  endpointId: string | null;
  endpoint?: { id: string; name: string };
  fallbackEndpointId: string | null;
  model: string;
  systemPrompt: string;
  userPromptTemplate: string;
  params: Record<string, unknown>;
  enabled: boolean;
  variables?: string[];
  version: number;
  updatedAt: string;
}

export interface AgentRunHistory {
  id: string;
  agentName: string;
  status: 'ok' | 'fallback' | 'failed';
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
  endpointId?: string;
  model?: string;
  error?: string | null;
}

export interface AgentTestResp {
  output: unknown;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  costUsd?: number;
  status: 'ok' | 'fallback' | 'failed';
  error?: string;
}

export const AGENT_LABELS: Record<string, string> = {
  channel_analyzer: 'Channel Analyzer',
  contact_extractor: 'Contact Extractor',
  contact_prioritizer: 'Contact Prioritizer',
  approach_strategist: 'Approach Strategist',
  opening_composer: 'Opening Composer',
  reply_composer: 'Reply Composer',
  intent_classifier: 'Intent Classifier',
  safety_filter: 'Safety Filter',
  handoff_decider: 'Handoff Decider',
  conversation_summarizer: 'Conversation Summarizer',
  next_action_planner: 'Next Action Planner',
  quality_reviewer: 'Quality Reviewer',
};

export const AGENT_CLASS: Record<string, 'cheap' | 'medium' | 'strong'> = {
  channel_analyzer: 'medium',
  contact_extractor: 'medium',
  contact_prioritizer: 'cheap',
  approach_strategist: 'medium',
  opening_composer: 'strong',
  reply_composer: 'strong',
  intent_classifier: 'cheap',
  safety_filter: 'cheap',
  handoff_decider: 'cheap',
  conversation_summarizer: 'medium',
  next_action_planner: 'medium',
  quality_reviewer: 'strong',
};
