/**
 * Walk a zod schema and produce a human-readable "Allowed values" block
 * that can be injected into the LLM system prompt.
 *
 * Why: every time the prompt fails to enumerate the legal enum tokens, the
 * model invents synonyms (`confirm_meeting`, `clarify_or_close`, …) and
 * we waste a turn — or a whole job — on tolerant coercers / repair loops.
 * Deriving the list from the schema means the prompt never lies and a new
 * enum value lands in the prompt for free.
 *
 * Coverage:
 *   - ZodEnum                              → "[a, b, c]"
 *   - ZodNativeEnum                        → values of the enum object
 *   - ZodLiteral (when in a union/array)   → the single literal
 *   - ZodObject / ZodArray / ZodTuple      → recursed
 *   - ZodOptional / ZodNullable / ZodDefault → unwrapped
 *   - ZodPreprocess (`z.preprocess`)       → unwrapped
 *   - ZodEffects (`.transform`, `.refine`) → unwrapped (inner schema)
 *   - ZodCatch  (`z.catch(...)`)           → unwrapped (the schema before the
 *                                            catch is what the LLM should aim
 *                                            for; the default only fires on
 *                                            failure)
 *   - ZodRecord                            → values recursed under "[*]"
 *
 * Anything else (string/number/boolean/unknown/...) — skipped silently. We
 * only enumerate fields that have a closed vocabulary worth telling the
 * model about.
 */

import { z, type ZodTypeAny } from 'zod';

interface EnumHint {
  path: string;
  allowed: readonly string[];
}

export function collectEnumHints(schema: ZodTypeAny): EnumHint[] {
  const out: EnumHint[] = [];
  walk(schema, '', out);
  // De-dupe by path — the same enum can appear inside variants[].intent_target
  // for multiple agents but we only want one line per path.
  const seen = new Set<string>();
  return out.filter((h) => {
    if (seen.has(h.path)) return false;
    seen.add(h.path);
    return true;
  });
}

/**
 * Render a hint block suitable to append to a system prompt. Empty string
 * if the schema has no enum fields.
 */
export function renderSchemaHints(schema: ZodTypeAny): string {
  const hints = collectEnumHints(schema);
  if (hints.length === 0) return '';
  const lines = hints.map((h) => `- ${h.path} ∈ [${h.allowed.join(', ')}]`);
  return [
    'Допустимые значения полей (используй ТОЛЬКО эти токены, без переводов и синонимов):',
    ...lines,
  ].join('\n');
}

/* ------------------------------------------------------------------ */

function walk(schema: ZodTypeAny, path: string, out: EnumHint[]): void {
  // Unwrap layered schemas first.
  const unwrapped = unwrap(schema);
  if (unwrapped !== schema) {
    walk(unwrapped, path, out);
    return;
  }

  const def = (schema as { _def?: { typeName?: string } })._def;
  const typeName = def?.typeName;

  if (typeName === 'ZodEnum') {
    const values = (schema as unknown as z.ZodEnum<[string, ...string[]]>)._def.values;
    out.push({ path: path || '<root>', allowed: values });
    return;
  }
  if (typeName === 'ZodNativeEnum') {
    const obj = (schema as unknown as { _def: { values: Record<string, string | number> } })._def
      .values;
    const allowed = Object.values(obj)
      .filter((v): v is string => typeof v === 'string')
      .map((v) => String(v));
    if (allowed.length > 0) out.push({ path: path || '<root>', allowed });
    return;
  }
  if (typeName === 'ZodLiteral') {
    const v = (schema as unknown as { _def: { value: unknown } })._def.value;
    if (typeof v === 'string') {
      out.push({ path: path || '<root>', allowed: [v] });
    }
    return;
  }
  if (typeName === 'ZodUnion' || typeName === 'ZodDiscriminatedUnion') {
    const options = (schema as unknown as { _def: { options: ZodTypeAny[] } })._def.options;
    // If every option is a string ZodLiteral, present them as a single enum-like list.
    const literals: string[] = [];
    let allLiteral = true;
    for (const opt of options) {
      const inner = unwrap(opt);
      const innerDef = (inner as { _def?: { typeName?: string; value?: unknown } })._def;
      if (innerDef?.typeName === 'ZodLiteral' && typeof innerDef.value === 'string') {
        literals.push(innerDef.value);
      } else {
        allLiteral = false;
        break;
      }
    }
    if (allLiteral && literals.length > 0) {
      out.push({ path: path || '<root>', allowed: literals });
      return;
    }
    for (const opt of options) walk(opt, path, out);
    return;
  }
  if (typeName === 'ZodObject') {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    for (const key of Object.keys(shape)) {
      walk(shape[key]!, path ? `${path}.${key}` : key, out);
    }
    return;
  }
  if (typeName === 'ZodArray') {
    const inner = (schema as unknown as { _def: { type: ZodTypeAny } })._def.type;
    walk(inner, `${path}[]`, out);
    return;
  }
  if (typeName === 'ZodTuple') {
    const items = (schema as unknown as { _def: { items: ZodTypeAny[] } })._def.items;
    items.forEach((it, i) => walk(it, `${path}[${i}]`, out));
    return;
  }
  if (typeName === 'ZodRecord') {
    const value = (schema as unknown as { _def: { valueType: ZodTypeAny } })._def.valueType;
    walk(value, `${path}[*]`, out);
    return;
  }
  // Anything else: not an enum-bearing branch.
}

/**
 * Strip wrapper schemas that don't change the enum vocabulary so we can
 * inspect the inner type. Returns the original schema if there's nothing to
 * unwrap.
 */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  const def = (schema as { _def?: { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny } })
    ._def;
  const t = def?.typeName;
  if (
    t === 'ZodOptional' ||
    t === 'ZodNullable' ||
    t === 'ZodDefault' ||
    t === 'ZodCatch' ||
    t === 'ZodReadonly' ||
    t === 'ZodBranded'
  ) {
    if (def?.innerType) return def.innerType;
  }
  if (t === 'ZodEffects') {
    // Covers .transform / .refine / .preprocess. Both shapes use _def.schema
    // for the wrapped inner.
    if (def?.schema) return def.schema;
  }
  // ZodPipeline (z.preprocess in zod ≥3.20 sometimes uses it): inner is `out`.
  if (t === 'ZodPipeline') {
    const out = (schema as unknown as { _def: { out: ZodTypeAny } })._def.out;
    if (out) return out;
  }
  return schema;
}
