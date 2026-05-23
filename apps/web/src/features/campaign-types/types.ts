// Local mirrors of @nosquare/shared campaign-type + builder zod-inferred types
// (packages/shared/src/schemas/{campaign-type,campaign-type-builder}.ts).

export type ModelTier = 'cheap' | 'medium' | 'strong';

export interface AgentSlot {
  agentName: string;
  overrides: Record<string, unknown>;
}

export type AgentSet = Record<string, AgentSlot>;

export interface SafetyProfile {
  forbidden_topics: string[];
  allowed_topics: string[];
  allow_links: boolean;
  max_length: number;
  [k: string]: unknown;
}

export interface AutonomyPolicy {
  defaultMode: 'auto' | 'semi_auto' | 'assisted' | 'manual';
  T_safety: number;
  T_semi_auto_goalfit: number;
  T_auto_goalfit: number;
  forceHandoffIntents: string[];
  [k: string]: unknown;
}

export interface CampaignType {
  id: string;
  key: string;
  name: string;
  description: string;
  goalSchema: Record<string, unknown>;
  agentSet: AgentSet;
  safetyProfile: SafetyProfile;
  autonomyPolicy: AutonomyPolicy;
  builtIn: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Builder ───

export interface BuildCampaignTypeInput {
  goal_description: string;
  examples?: string[];
  constraints?: Record<string, unknown>;
}

export interface DraftAgentConfig {
  role: string;
  name: string;
  description: string;
  tier: ModelTier;
  endpointId: string | null;
  provider: string | null;
  model: string | null;
  tierAvailable: boolean;
  systemPrompt: string;
  userPromptTemplate: string;
  params: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown> | null;
}

export interface DraftAgentTestResult {
  role: string;
  name: string;
  ran: boolean;
  skippedReason: string | null;
  output?: unknown;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  error: string | null;
}

export interface CampaignTypeDraft {
  draftId: string;
  key: string;
  name: string;
  description: string;
  goalSchema: Record<string, unknown>;
  safetyProfile: SafetyProfile;
  autonomyPolicy: AutonomyPolicy;
  agentSet: AgentSet;
  agents: DraftAgentConfig[];
  testResults: DraftAgentTestResult[];
  unavailableTiers: ModelTier[];
}
