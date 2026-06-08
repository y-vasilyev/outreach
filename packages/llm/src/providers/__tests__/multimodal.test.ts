import { describe, it, expect } from 'vitest';
import { buildUserMessageContent } from '../openrouter.js';
import type { CompletionRequest } from '../../types.js';

const base: CompletionRequest = { systemPrompt: 's', userPrompt: 'u', model: 'm' };

describe('buildUserMessageContent (attachment-ocr-ingestion)', () => {
  it('text-only request → plain string content (byte-identical)', () => {
    expect(buildUserMessageContent(base, 'openrouter')).toBe('u');
    expect(buildUserMessageContent(base, 'openai_compat')).toBe('u');
  });

  it('OpenRouter + images → multimodal content parts', () => {
    const req = { ...base, images: [{ url: 'data:image/png;base64,AAA' }] };
    const content = buildUserMessageContent(req, 'openrouter') as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'u' });
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
  });

  it('openai_compat ignores images (stays string content)', () => {
    const req = { ...base, images: [{ url: 'data:image/png;base64,AAA' }] };
    expect(buildUserMessageContent(req, 'openai_compat')).toBe('u');
  });
});
