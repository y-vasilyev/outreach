import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { mountWithApp } from '../../../__tests__/mount-with-app';
import OpenerStatsPanel from '../OpenerStatsPanel.vue';
import type { OpenerStatsRow } from '../types';

// Mock the API client. Each test sets `apiGet.mockResolvedValue(...)` /
// `apiGet.mockRejectedValue(...)` before mounting.
vi.mock('../../../lib/api', () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {
    code: string; status: number;
    constructor(code: string, message: string, status: number) {
      super(message); this.code = code; this.status = status;
    }
  },
}));
import { api } from '../../../lib/api';
const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

function row(variantKey: string, sent: number, replied: number): OpenerStatsRow {
  return { variantKey, sent, replied, replyRate: sent > 0 ? replied / sent : 0 };
}

beforeEach(() => {
  apiGet.mockReset();
});

describe('OpenerStatsPanel', () => {
  it('renders loading state before the query resolves', async () => {
    // Pending promise → loading branch.
    apiGet.mockReturnValue(new Promise(() => {}));
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c1' } });
    await flushPromises();
    expect(wrapper.html()).toContain('class="spinner"');
  });

  it('renders empty placeholder when API returns []', async () => {
    apiGet.mockResolvedValue([]);
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c1' } });
    await flushPromises();
    expect(wrapper.text()).toContain('Нет данных');
    expect(wrapper.text()).toContain('opener-вариантом');
  });

  it('renders error message when API rejects', async () => {
    apiGet.mockRejectedValue(new Error('boom'));
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c1' } });
    await flushPromises();
    expect(wrapper.text()).toContain('Не удалось загрузить');
  });

  it('fetches with default window (48h) on initial mount', async () => {
    apiGet.mockResolvedValue([]);
    mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c-default' } });
    await flushPromises();
    expect(apiGet).toHaveBeenCalledWith('/campaigns/c-default/opener-stats?withinHours=48');
  });

  it('refetches with new withinHours when a window tab is clicked', async () => {
    apiGet.mockResolvedValue([]);
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c-tab' } });
    await flushPromises();
    apiGet.mockClear();
    // Find the "7 д" tab and click.
    const tab168 = wrapper.findAll('.tab').find((b) => b.text().includes('7 д'));
    expect(tab168, 'expected a "7 д" tab to be rendered').toBeDefined();
    await tab168!.trigger('click');
    await flushPromises();
    expect(apiGet).toHaveBeenCalledWith('/campaigns/c-tab/opener-stats?withinHours=168');
  });

  it('sorts rows by replyRate desc (best on top)', async () => {
    apiGet.mockResolvedValue([
      row('low', 100, 20),   // 0.20
      row('hi', 100, 80),    // 0.80
      row('mid', 100, 50),   // 0.50
    ]);
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c-sort' } });
    await flushPromises();
    const variantCells = wrapper.findAll('tbody tr td.cell-strong').map((td) => td.text());
    expect(variantCells.slice(0, 3)).toEqual(['hi', 'mid', 'low']);
  });

  it('tie-breaks equal replyRate by sent desc (more samples wins)', async () => {
    apiGet.mockResolvedValue([
      row('small', 1, 1),     // 1.0, sent=1
      row('large', 100, 100), // 1.0, sent=100
    ]);
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c-tie1' } });
    await flushPromises();
    const variantCells = wrapper.findAll('tbody tr td.cell-strong').map((td) => td.text());
    expect(variantCells.slice(0, 2)).toEqual(['large', 'small']);
  });

  it('final tie-break is variantKey asc when rate and sent both equal', async () => {
    apiGet.mockResolvedValue([
      row('b', 10, 5),
      row('a', 10, 5),
    ]);
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c-tie2' } });
    await flushPromises();
    const variantCells = wrapper.findAll('tbody tr td.cell-strong').map((td) => td.text());
    expect(variantCells.slice(0, 2)).toEqual(['a', 'b']);
  });

  it('totals row sums sent + replied and computes aggregate rate', async () => {
    apiGet.mockResolvedValue([
      row('A', 10, 3),
      row('B', 20, 5),
    ]);
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c-totals' } });
    await flushPromises();
    const totalsRow = wrapper.findAll('tbody tr').at(-1);
    expect(totalsRow, 'expected a final totals row').toBeDefined();
    const cells = totalsRow!.findAll('td').map((td) => td.text());
    // [Итого, sent=30, replied=8, rate]
    expect(cells[1]).toContain('30');
    expect(cells[2]).toContain('8');
    // 8/30 = 26.7%
    expect(cells[3]).toContain('26.7%');
  });

  it('totals rate is 0% (not NaN) when all variants have sent=0', async () => {
    // A row with sent=0 actually exercises the divide-by-sent code path in
    // both the row's replyRate (clamped server-side, so 0 here) AND the
    // totals row's `sent > 0 ? replied/sent : 0`. An empty array would only
    // render the empty placeholder and miss the totals branch entirely.
    apiGet.mockResolvedValue([row('zero', 0, 0)]);
    const { wrapper } = mountWithApp(OpenerStatsPanel, { props: { campaignId: 'c-zero' } });
    await flushPromises();
    expect(wrapper.html()).not.toContain('NaN');
    expect(wrapper.html()).not.toContain('Infinity');
    // Totals row last; check the rate cell shows 0.0%, not NaN%.
    const totalsRow = wrapper.findAll('tbody tr').at(-1)!;
    const cells = totalsRow.findAll('td').map((td) => td.text());
    expect(cells[3]).toContain('0.0%');
  });
});
