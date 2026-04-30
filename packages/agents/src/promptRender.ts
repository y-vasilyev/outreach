/**
 * Renders `{{var}}` placeholders inside a template string.
 *
 *  - whitespace tolerant: `{{  var  }}`, `{{var}}`, `{{ var}}` all match
 *  - unknown placeholders → empty string + debug log
 *  - non-string values are stringified (objects/arrays via JSON.stringify,
 *    primitives via String())
 */

export interface RenderLogger {
  debug?: (...args: unknown[]) => void;
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderTemplate(
  tpl: string,
  vars: Record<string, unknown>,
  logger?: RenderLogger,
): string {
  if (!tpl) return '';
  return tpl.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (!(name in vars)) {
      logger?.debug?.({ var: name }, 'promptRender: unknown variable, substituting empty string');
      return '';
    }
    const v = vars[name];
    return stringifyValue(v);
  });
}

function stringifyValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
