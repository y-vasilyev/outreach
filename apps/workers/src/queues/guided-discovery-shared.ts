import {
  GuidedRunBudgetsZ,
  GuidedRunInputSnapshotZ,
  GuidedRunSummaryZ,
  DiscoveryTraceEventZ,
  PlannedQueryZ,
  type GuidedRunInputSnapshot,
  type GuidedRunSummary,
  type PlannedQuery,
  type DiscoveryTraceEvent,
  type DiscoveryTraceStage,
} from '@nosquare/shared';

/**
 * Shared parse/trace/persist helpers for the guided-discovery evidence loop
 * (fix-guided-discovery-evidence-loop). Both the phase-1 worker
 * (`guided-discovery.ts`) and the per-candidate review worker
 * (`guided-discovery-review.ts`) operate over the same `DiscoveryRun` row and
 * must read/write the sanitized trace + summary the same way.
 */

export function parseSnapshot(raw: unknown): GuidedRunInputSnapshot {
  const parsed = GuidedRunInputSnapshotZ.safeParse(raw);
  return parsed.success
    ? parsed.data
    : GuidedRunInputSnapshotZ.parse({ budgets: GuidedRunBudgetsZ.parse({}) });
}

export function parseSummary(
  raw: unknown,
  budgets: GuidedRunSummary['budgets'],
): GuidedRunSummary {
  const parsed = GuidedRunSummaryZ.safeParse(raw);
  return parsed.success && (raw as { budgets?: unknown } | null)?.budgets
    ? parsed.data
    : GuidedRunSummaryZ.parse({ budgets });
}

export function parseTrace(raw: unknown): DiscoveryTraceEvent[] {
  return Array.isArray(raw)
    ? raw
        .map((e) => DiscoveryTraceEventZ.safeParse(e))
        .filter((r): r is { success: true; data: DiscoveryTraceEvent } => r.success)
        .map((r) => r.data)
    : [];
}

export function parsePlannedQueries(raw: unknown): PlannedQuery[] {
  return Array.isArray(raw)
    ? raw
        .map((q) => PlannedQueryZ.safeParse(q))
        .filter((r): r is { success: true; data: PlannedQuery } => r.success)
        .map((r) => r.data)
    : [];
}

/** Push a sanitized trace event (default `status: 'info'`) onto a trace array. */
export function makeAddTrace(trace: DiscoveryTraceEvent[]) {
  return (e: Partial<DiscoveryTraceEvent> & { stage: DiscoveryTraceStage }): void => {
    trace.push(
      DiscoveryTraceEventZ.parse({ ts: new Date().toISOString(), status: 'info', ...e }),
    );
  };
}
