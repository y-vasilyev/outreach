export interface LLMEndpoint {
  id: string;
  name: string;
  provider: 'yandex' | 'openrouter' | 'openai_compat';
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  rateLimitRpm?: number | null;
  enabled: boolean;
  hasProxy?: boolean;
  createdAt: string;
  updatedAt: string;
}
