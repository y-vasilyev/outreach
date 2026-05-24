import { describe, it, expect } from 'vitest';
import { ApiError } from '../../../lib/api';
import {
  batchProgress,
  perQueryLabel,
  perQueryPill,
  pollInterval,
  statusPill,
} from '../helpers';
import type { DiscoveryBatchStatus } from '../types';

function makeStatus(
  status: DiscoveryBatchStatus['status'],
  totals?: Partial<DiscoveryBatchStatus['summary']['totals']>,
): DiscoveryBatchStatus {
  return {
    id: 'b',
    status,
    createdAt: '2026-05-24T00:00:00.000Z',
    completedAt: null,
    platform: null,
    limitPerQuery: 20,
    summary: {
      totals: {
        queries: 0, processed: 0, created: 0, alreadyKnown: 0, errored: 0,
        ...totals,
      },
      queries: [],
    },
  };
}

describe('pollInterval', () => {
  it('returns 3000 while data is undefined (initial load)', () => {
    expect(pollInterval(undefined, null)).toBe(3000);
  });

  it('returns 3000 for non-terminal statuses (pending / running)', () => {
    expect(pollInterval(makeStatus('pending'), null)).toBe(3000);
    expect(pollInterval(makeStatus('running'), null)).toBe(3000);
  });

  it('returns false for terminal statuses (done / failed)', () => {
    expect(pollInterval(makeStatus('done'), null)).toBe(false);
    expect(pollInterval(makeStatus('failed'), null)).toBe(false);
  });

  it('returns false on ApiError 403 (auth)', () => {
    expect(pollInterval(undefined, new ApiError('FORBIDDEN', 'no', 403))).toBe(false);
  });

  it('returns false on ApiError 404 (regardless of code — feature-off or NOT_FOUND)', () => {
    expect(pollInterval(undefined, new ApiError('NOT_FOUND', 'no', 404))).toBe(false);
    expect(pollInterval(undefined, new ApiError('HTTP_404', 'flag off', 404))).toBe(false);
  });

  it('keeps polling (3000ms) on other ApiError statuses — transient 5xx, 502, etc.', () => {
    expect(pollInterval(undefined, new ApiError('INTERNAL', 'boom', 500))).toBe(3000);
    expect(pollInterval(undefined, new ApiError('BAD_GATEWAY', 'boom', 502))).toBe(3000);
  });

  it('keeps polling on non-ApiError errors (network blip etc.)', () => {
    expect(pollInterval(undefined, new Error('network'))).toBe(3000);
  });
});

describe('statusPill', () => {
  it('maps each batch status to its tone', () => {
    expect(statusPill('done')).toBe('ok');
    expect(statusPill('failed')).toBe('bad');
    expect(statusPill('running')).toBe('accent');
    expect(statusPill('pending')).toBe('ghost');
  });
});

describe('perQueryPill / perQueryLabel', () => {
  it('error wins over done', () => {
    // A row that completed with an error should still render as bad, never ok.
    expect(perQueryPill({ done: true, error: 'parse fail' })).toBe('bad');
    expect(perQueryLabel({ done: true, error: 'parse fail' })).toBe('error');
  });

  it('done without error → ok', () => {
    expect(perQueryPill({ done: true })).toBe('ok');
    expect(perQueryLabel({ done: true })).toBe('done');
  });

  it('not done and no error → pending', () => {
    expect(perQueryPill({ done: false })).toBe('ghost');
    expect(perQueryLabel({ done: false })).toBe('pending');
  });
});

describe('batchProgress', () => {
  it('returns 0 when totals is undefined (no batch loaded)', () => {
    expect(batchProgress(undefined)).toBe(0);
  });

  it('returns 0 when no queries scheduled (queries=0 — would be NaN without the guard)', () => {
    expect(batchProgress({ processed: 0, queries: 0 })).toBe(0);
  });

  it('computes processed/queries as a 0..1 ratio', () => {
    expect(batchProgress({ processed: 5, queries: 10 })).toBe(0.5);
    expect(batchProgress({ processed: 3, queries: 4 })).toBe(0.75);
  });

  it('clamps above-1 ratios (defensive — backend should never send these)', () => {
    expect(batchProgress({ processed: 50, queries: 10 })).toBe(1);
  });

  it('clamps negative ratios', () => {
    expect(batchProgress({ processed: -1, queries: 10 })).toBe(0);
  });
});
