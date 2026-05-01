import { Errors } from '@nosquare/shared/errors';

/**
 * Strip markdown fences and extract the first balanced JSON object/array
 * from a potentially noisy LLM response.
 *
 * Handles:
 *   - ```json ... ``` and ``` ... ``` fences (any language tag)
 *   - garbage prose before / after the JSON block
 *   - braces inside string literals (does not count them as nesting)
 */
export function extractJson(text: string): string {
  if (typeof text !== 'string') {
    // Programmer error — caller passed a non-string. Distinct from the
    // content-level failures below.
    throw Errors.badRequest('extractJson: input must be a string');
  }

  let body = text.trim();

  // Strip a leading ``` fence (with optional language tag) and trailing ```.
  const fenceMatch = body.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && fenceMatch[1] != null) {
    body = fenceMatch[1].trim();
  }

  // Find first { or [ and the matching closing bracket using a balance scan
  // that respects string literals and escapes.
  const openIdx = findFirstStructural(body);
  if (openIdx < 0) {
    // Model returned prose instead of JSON ("Sorry, I can't do that.").
    // This is a content failure, not a programmer/transport bug — surface it
    // as LLM_INVALID_JSON so the repair-loop in wrap.completeJson kicks in.
    throw Errors.llmInvalidJson('extractJson: no JSON object or array found', {
      preview: body.slice(0, 200),
    });
  }

  const open = body[openIdx];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = openIdx; i < body.length; i++) {
    const ch = body[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return body.slice(openIdx, i + 1);
      }
    }
  }

  // Model started a JSON block but didn't close it (truncation, max_tokens
  // hit, …). Same category as "no JSON" — repairable.
  throw Errors.llmInvalidJson('extractJson: unbalanced JSON', {
    preview: body.slice(0, 200),
  });
}

function findFirstStructural(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '[') return i;
  }
  return -1;
}

/**
 * Extracts JSON from `text`, parses it, then validates with the supplied
 * parser callback (typically a zod `.parse`). Throws:
 *   - `LLM_INVALID_JSON` when the model didn't return parseable JSON at all.
 *   - `LLM_SCHEMA_FAILED` when JSON parsed but failed validation. The error's
 *     `details.message` is the zod message and `details.preview` is the raw
 *     JSON — the repair-loop in `wrap.completeJson` feeds both back to the
 *     model on the retry attempt.
 */
export function parseJsonStrict<T>(text: string, parser: (v: unknown) => T): T {
  const json = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw Errors.llmInvalidJson('LLM returned invalid JSON', {
      message: (e as Error).message,
      preview: json.slice(0, 200),
    });
  }
  try {
    return parser(parsed);
  } catch (e) {
    throw Errors.llmSchemaFailed('LLM JSON failed validation', {
      message: (e as Error).message,
      // First 600 chars of the response is enough to tell whether the model
      // returned the wrong schema, hallucinated fields, etc.
      preview: json.slice(0, 600),
    });
  }
}
