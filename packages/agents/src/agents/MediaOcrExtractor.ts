import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeVisionText } from './_runtime.js';

/**
 * MediaOcrExtractor — `media_ocr_extractor` (attachment-ocr-ingestion).
 *
 * Transcribes an attachment IMAGE (price list / media kit / stats screenshot)
 * to verbatim text via OpenRouter vision. It does NOT structure the data — the
 * recognized text is fed back into the existing rate/audience extractors.
 *
 * Input is METADATA + the image side channel: `images[].url` (a data-URL) is
 * redacted before `agent_run.input` is persisted (see AgentRunner), so base64
 * bytes never land in the DB. The agent emits plain transcribed text.
 */

export const mediaOcrExtractorInputSchema = z.object({
  /** Provenance only (persisted). */
  assetId: z.string().default(''),
  mime: z.string().optional(),
  sha256: z.string().optional(),
  /** Image inputs (data-URLs). Redacted from the persisted run input. */
  images: z.array(z.object({ url: z.string().min(1) })).default([]),
});

export const mediaOcrExtractorOutputSchema = z.object({
  text: z.string().default(''),
});

export type MediaOcrExtractorInput = z.infer<typeof mediaOcrExtractorInputSchema>;
export type MediaOcrExtractorOutput = z.infer<typeof mediaOcrExtractorOutputSchema>;

const FALLBACK_SYSTEM = `Ты — OCR. На вход — изображение (прайс блогера, медиакит, скриншот статистики). Распознай и верни ВЕСЬ ТЕКСТ с картинки ДОСЛОВНО, сохраняя строки, цифры, валюты и проценты. НИЧЕГО не придумывай и не добавляй: только то, что реально видно. Не структурируй, не комментируй — просто текст. Если текста нет — верни пустую строку.`;

const FALLBACK_USER = `Распознай весь текст с изображения дословно.`;

export const mediaOcrExtractor: Agent<MediaOcrExtractorInput, MediaOcrExtractorOutput> = {
  name: 'media_ocr_extractor',
  description:
    'Распознаёт (OCR) текст с изображения-вложения блогера (прайс/медиакит/скриншот) дословно через vision-модель.',
  inputSchema: mediaOcrExtractorInputSchema,
  outputSchema: mediaOcrExtractorOutputSchema,
  variables: [],
  // Vision-capable OpenRouter model; tune in agent_config.
  defaultModel: 'google/gemini-3-flash-preview',
  defaultParams: { temperature: 0, max_tokens: 1500 },
  async run(input, ctx) {
    if (!input.images || input.images.length === 0) return { text: '' };
    const text = await invokeVisionText({
      ctx,
      vars: {},
      images: input.images,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
    return { text: typeof text === 'string' ? text.trim() : '' };
  },
};
