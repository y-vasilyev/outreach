/**
 * Helpers for the A/B opener-variants attribution path (ab-opener-variants
 * change).
 *
 * The composers (`opening_composer`, `agency_opening_composer`) tag every
 * variant with a stable `variantKey`. Workers/dispatchers persist that key
 * on `Suggestion.meta.openerVariant`. The auto-send (`tryAutoApprove`) and
 * operator-approve (`approveSuggestion → sendOperatorMessage`) paths both
 * need to read the key off the source suggestion and forward it onto
 * `Message.openerVariant` — but ONLY when the source agent is an opener
 * composer, and ONLY when the value is a valid short string.
 *
 * The same extraction helper lives in `@nosquare/shared` so api and
 * workers stay in lockstep about what counts as a real opener variant
 * (vs. corrupted meta or a misfire from a non-opener agent).
 */

/**
 * Canonical list of agent names that produce opener Suggestions. Exported
 * as an `as const` tuple so callers can both (a) feed it to `Prisma`
 * queries via `{ in: [...OPENER_AGENT_NAMES] }` and (b) narrow against the
 * literal union via `OpenerAgentName`. Add new opener agents here in ONE
 * place — dispatcher, agent-run, addContacts dedup, and the meta-extractor
 * all derive from this tuple.
 */
export const OPENER_AGENT_NAMES = [
  'opening_composer',
  'agency_opening_composer',
] as const;

export type OpenerAgentName = (typeof OPENER_AGENT_NAMES)[number];

const OPENER_AGENT_NAME_SET: ReadonlySet<string> = new Set(OPENER_AGENT_NAMES);

/** Max length the composer post-process caps at; anything longer is treated as corrupted. */
const MAX_VARIANT_KEY_LEN = 32;

/** Cheap inline type — both callers (api / workers) have a `Suggestion` row in scope. */
export interface OpenerSuggestionSlice {
  agentName: string;
  meta: unknown;
}

/**
 * Pull `meta.openerVariant` off a suggestion row and return it ONLY if
 * the suggestion came from an opener composer. Returns `null` for:
 *   - missing suggestion
 *   - non-opener agentName (`reply_composer`, `data_collection_planner`, …)
 *   - meta missing / not an object / `openerVariant` missing
 *   - non-string `openerVariant` (defends against corrupted operator-edited meta)
 *   - empty / whitespace-only `openerVariant`
 *   - `openerVariant` longer than 32 chars (post-process never emits these)
 */
export function extractOpenerVariant(
  sug: OpenerSuggestionSlice | null | undefined,
): string | null {
  if (!sug) return null;
  if (!OPENER_AGENT_NAME_SET.has(sug.agentName)) return null;
  if (!sug.meta || typeof sug.meta !== 'object') return null;
  const raw = (sug.meta as { openerVariant?: unknown }).openerVariant;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_VARIANT_KEY_LEN) return null;
  return trimmed;
}
