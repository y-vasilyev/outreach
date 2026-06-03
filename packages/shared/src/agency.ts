/**
 * Agency-sourcing helpers (harden-agency-sourcing-pipeline change).
 *
 * Keep this file thin and pure — no DB / feature-flag imports — so workers
 * and api can both depend on it and unit tests stay trivial.
 */

interface AgencyCampaignLite {
  goal?: unknown;
  valueProp?: string | null;
}

/**
 * Read the agency campaign's `client_brief` from its structured goal
 * (`campaign.goal.client_brief`), falling back to the legacy `valueProp`
 * text only when no structured brief is present. The agency goal editor
 * writes brief into `goal.client_brief`; older campaigns predate that
 * field and still carry the same text in `valueProp` — fallback keeps
 * them working without a backfill.
 *
 * Returns a string (possibly empty) — never undefined — so callers can
 * pass it straight into the agency opener input.
 */
export function extractAgencyClientBrief(
  campaign: AgencyCampaignLite | null | undefined,
): string {
  const goal = campaign?.goal;
  if (goal && typeof goal === 'object') {
    const raw = (goal as { client_brief?: unknown }).client_brief;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  }
  if (typeof campaign?.valueProp === 'string') return campaign.valueProp;
  return '';
}
