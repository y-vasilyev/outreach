/**
 * Core LLM provider types.
 *
 * Providers wrap a single upstream (Yandex / OpenRouter / OpenAI-compat).
 * They do not know about agents or DB — the AgentRunner is responsible
 * for loading endpoints, picking a provider via the factory and writing
 * `agent_run` rows.
 */

export type ProviderKind = 'yandex' | 'openrouter' | 'openai_compat';

export interface CompletionRequestMetadata {
  /**
   * Free-form bag attached to the request. Decorators (e.g. withFallback) can
   * write here so the caller knows which provider was actually used.
   */
  providerUsed?: string;
  [key: string]: unknown;
}

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  jsonMode?: boolean;
  /** JSON-schema for structured output (used by providers that support it). */
  responseSchema?: unknown;
  abortSignal?: AbortSignal;
  metadata?: CompletionRequestMetadata;
}

export interface CompletionResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  /**
   * Optional reference to the raw provider response. Callers must NOT log this
   * directly — it can include user content and provider-specific fields.
   */
  raw?: unknown;
  /** Marker added by withFallback so the caller can record which provider succeeded. */
  providerUsed?: string;
}

export interface ModelInfo {
  /** Provider-specific model id passed back as `CompletionRequest.model`. */
  id: string;
  /** Human-friendly name (defaults to id when the provider doesn't ship one). */
  name?: string;
  /** Free-form provider description. */
  description?: string;
  /** Max input context window (tokens) when reported. */
  contextLength?: number;
  /** Pricing in USD per 1M tokens, when reported. */
  pricing?: { promptPer1M?: number; completionPer1M?: number };
}

export interface LLMProvider {
  readonly kind: ProviderKind;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  completeJson<T>(
    req: CompletionRequest,
    parser: (raw: string) => T,
  ): Promise<{ value: T; meta: CompletionResponse }>;
  /** Cheap synchronous estimate. Used for budgeting before a real call. */
  estimateTokens(text: string): number;
  /** List models this endpoint can serve. May be cached / hardcoded. */
  listModels(): Promise<ModelInfo[]>;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  /** Yandex Cloud folder id — required for Yandex. */
  folderId?: string;
  /** Yandex IAM token (alternative to apiKey, takes priority if set). */
  iamToken?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export interface TokenAccountingRun {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  latencyMs: number;
  status: 'ok' | 'failed';
  error?: string;
  providerKind: ProviderKind;
}

export type TokenAccountingHook = (run: TokenAccountingRun) => void | Promise<void>;
