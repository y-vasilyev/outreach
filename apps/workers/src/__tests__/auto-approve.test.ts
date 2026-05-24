import { beforeEach, describe, expect, it, vi } from 'vitest';

// vitest hoists `vi.mock` factories above all imports. Mock state has to
// be created via `vi.hoisted` so the factory can close over real `vi.fn`
// instances at hoist time.
const mocks = vi.hoisted(() => {
  const prisma = {
    conversation: { findUnique: vi.fn() },
    suggestion: { update: vi.fn(), findUnique: vi.fn() },
    message: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  const tgSendAdd = vi.fn();
  const publishRealtime = vi.fn();
  return { prisma, tgSendAdd, publishRealtime };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));
vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.tgSendAdd;
  },
}));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/realtime-emit.js', () => ({
  publishRealtime: mocks.publishRealtime,
}));

// Imported AFTER mocks.
import {
  tryAutoApprove,
  T_SAFETY,
  T_SEMI_AUTO_GOALFIT,
  T_AUTO_GOALFIT,
  extractOpenerVariant,
} from '../services/auto-approve.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.conversation.findUnique.mockReset();
  mocks.prisma.suggestion.update.mockReset();
  mocks.prisma.suggestion.update.mockResolvedValue({});
  mocks.prisma.suggestion.findUnique.mockReset();
  // Default: no opener metadata. Individual tests can override per case.
  mocks.prisma.suggestion.findUnique.mockResolvedValue({
    agentName: 'reply_composer',
    meta: {},
  });
  mocks.prisma.message.create.mockReset();
  mocks.prisma.message.create.mockResolvedValue({ id: 'msg1' });
  mocks.prisma.$transaction.mockReset();
  mocks.prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) => fn(mocks.prisma),
  );
  mocks.tgSendAdd.mockReset();
  mocks.tgSendAdd.mockResolvedValue({});
  mocks.publishRealtime.mockReset();
  mocks.publishRealtime.mockResolvedValue(undefined);
});

function setConv(mode: 'manual' | 'assisted' | 'semi_auto' | 'auto', status = 'active'): void {
  mocks.prisma.conversation.findUnique.mockResolvedValue({
    id: 'conv1',
    tgAccountId: 'tg1',
    mode,
    status,
  });
}

const baseCtx = {
  conversationId: 'conv1',
  suggestionId: 'sug1',
  text: 'hello',
};

describe('tryAutoApprove — composition rule', () => {
  describe('hard guards (apply to every mode)', () => {
    it('refuses when safety score is below T_SAFETY', async () => {
      setConv('auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: T_SAFETY - 0.01,
        gate: { action: 'continue', score: 0.95 },
      });
      expect(ok).toBe(false);
      expect(mocks.prisma.conversation.findUnique).not.toHaveBeenCalled();
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });

    it('refuses when conversation is missing', async () => {
      mocks.prisma.conversation.findUnique.mockResolvedValueOnce(null);
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        gate: { action: 'continue', score: 0.95 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });

    it('refuses when conversation status is not active', async () => {
      setConv('auto', 'paused');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        gate: { action: 'continue', score: 0.95 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });
  });

  describe('mode = manual', () => {
    it('never auto-sends, even with perfect signals', async () => {
      setConv('manual');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 1.0,
        gate: { action: 'continue', score: 1.0 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });
  });

  describe('mode = assisted', () => {
    it('never auto-sends', async () => {
      setConv('assisted');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 1.0,
        gate: { action: 'continue', score: 1.0 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });
  });

  describe('mode = semi_auto', () => {
    it('auto-sends on continue + safety + score ≥ T_SEMI_AUTO_GOALFIT', async () => {
      setConv('semi_auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        gate: { action: 'continue', score: T_SEMI_AUTO_GOALFIT },
      });
      expect(ok).toBe(true);
      expect(mocks.prisma.message.create).toHaveBeenCalledTimes(1);
      expect(mocks.tgSendAdd).toHaveBeenCalledTimes(1);
      expect(mocks.publishRealtime).toHaveBeenCalledWith(
        'conversation:conv1',
        expect.objectContaining({ type: 'suggestion.approved', auto: true }),
      );
    });

    it('auto-sends on soften + safety + score ≥ T_SEMI_AUTO_GOALFIT (semi-auto is permissive)', async () => {
      setConv('semi_auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        gate: { action: 'soften', score: T_SEMI_AUTO_GOALFIT + 0.05 },
      });
      expect(ok).toBe(true);
      expect(mocks.tgSendAdd).toHaveBeenCalledTimes(1);
    });

    it('refuses on handoff_silent regardless of score', async () => {
      setConv('semi_auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.95,
        gate: { action: 'handoff_silent', score: 0.99 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });

    it('refuses when gate.score is below T_SEMI_AUTO_GOALFIT', async () => {
      setConv('semi_auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.95,
        gate: { action: 'continue', score: T_SEMI_AUTO_GOALFIT - 0.01 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });

    it('auto-sends in legacy opener flow without a gate (semi_auto = legacy auto)', async () => {
      // Opener phase — no goal-fit gate is run, only safety. Per the
      // composition contract, semi_auto without gate falls through to
      // safety-only checks (matching the pre-change `auto` behaviour).
      setConv('semi_auto');
      const ok = await tryAutoApprove({ ...baseCtx, score: 0.9 });
      expect(ok).toBe(true);
      expect(mocks.tgSendAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe('mode = auto (strict)', () => {
    it('auto-sends on continue + safety + score ≥ T_AUTO_GOALFIT', async () => {
      setConv('auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        gate: { action: 'continue', score: T_AUTO_GOALFIT },
      });
      expect(ok).toBe(true);
      expect(mocks.tgSendAdd).toHaveBeenCalledTimes(1);
    });

    it('refuses on soften, even with high score (strict mode rejects drift)', async () => {
      setConv('auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.95,
        gate: { action: 'soften', score: 0.95 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });

    it('refuses on handoff_silent', async () => {
      setConv('auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.95,
        gate: { action: 'handoff_silent', score: 0.4 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });

    it('refuses when gate.score is below T_AUTO_GOALFIT (stricter than semi_auto)', async () => {
      setConv('auto');
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.95,
        gate: { action: 'continue', score: T_AUTO_GOALFIT - 0.01 },
      });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });

    it('refuses when no gate decision is provided (auto mode REQUIRES the gate)', async () => {
      setConv('auto');
      const ok = await tryAutoApprove({ ...baseCtx, score: 0.95 });
      expect(ok).toBe(false);
      expect(mocks.tgSendAdd).not.toHaveBeenCalled();
    });
  });

  describe('openerVariant propagation (ab-opener-variants)', () => {
    it('writes Message.openerVariant when the source suggestion is opening_composer', async () => {
      setConv('semi_auto');
      mocks.prisma.suggestion.findUnique.mockResolvedValueOnce({
        agentName: 'opening_composer',
        meta: { openerVariant: 'B' },
      });
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        phase: 'first_touch',
      });
      expect(ok).toBe(true);
      expect(mocks.prisma.message.create).toHaveBeenCalledTimes(1);
      expect(mocks.prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ openerVariant: 'B' }),
      });
    });

    it('writes Message.openerVariant for agency_opening_composer too', async () => {
      setConv('semi_auto');
      mocks.prisma.suggestion.findUnique.mockResolvedValueOnce({
        agentName: 'agency_opening_composer',
        meta: { openerVariant: 'with_brand' },
      });
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        phase: 'first_touch',
      });
      expect(ok).toBe(true);
      expect(mocks.prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ openerVariant: 'with_brand' }),
      });
    });

    it('does NOT set openerVariant when the suggestion is a reply (different agent)', async () => {
      setConv('semi_auto');
      mocks.prisma.suggestion.findUnique.mockResolvedValueOnce({
        agentName: 'reply_composer',
        // Reply suggestions never carry this meta key in production,
        // but defend against an operator stamping it manually.
        meta: { openerVariant: 'A' },
      });
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        gate: { action: 'continue', score: T_SEMI_AUTO_GOALFIT },
      });
      expect(ok).toBe(true);
      const createCall = mocks.prisma.message.create.mock.calls[0]![0];
      expect(createCall.data.openerVariant).toBeUndefined();
    });

    it('does NOT set openerVariant when meta.openerVariant is missing', async () => {
      setConv('semi_auto');
      mocks.prisma.suggestion.findUnique.mockResolvedValueOnce({
        agentName: 'opening_composer',
        meta: {},
      });
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        phase: 'first_touch',
      });
      expect(ok).toBe(true);
      const createCall = mocks.prisma.message.create.mock.calls[0]![0];
      expect(createCall.data.openerVariant).toBeUndefined();
    });

    it('does NOT set openerVariant when meta is corrupted (non-string)', async () => {
      setConv('semi_auto');
      mocks.prisma.suggestion.findUnique.mockResolvedValueOnce({
        agentName: 'opening_composer',
        meta: { openerVariant: 42 },
      });
      const ok = await tryAutoApprove({
        ...baseCtx,
        score: 0.9,
        phase: 'first_touch',
      });
      expect(ok).toBe(true);
      const createCall = mocks.prisma.message.create.mock.calls[0]![0];
      expect(createCall.data.openerVariant).toBeUndefined();
    });
  });

  describe('extractOpenerVariant helper', () => {
    it('returns null for null suggestion', () => {
      expect(extractOpenerVariant(null)).toBeNull();
    });

    it('returns null for non-opener agentName', () => {
      expect(
        extractOpenerVariant({ agentName: 'reply_composer', meta: { openerVariant: 'A' } }),
      ).toBeNull();
    });

    it('returns the variantKey for opening_composer', () => {
      expect(
        extractOpenerVariant({ agentName: 'opening_composer', meta: { openerVariant: 'value_prop' } }),
      ).toBe('value_prop');
    });

    it('returns the variantKey for agency_opening_composer', () => {
      expect(
        extractOpenerVariant({
          agentName: 'agency_opening_composer',
          meta: { openerVariant: 'concise' },
        }),
      ).toBe('concise');
    });

    it('trims whitespace and returns null for blank', () => {
      expect(
        extractOpenerVariant({ agentName: 'opening_composer', meta: { openerVariant: '   ' } }),
      ).toBeNull();
    });

    it('rejects strings longer than 32 chars (treats as corrupted)', () => {
      const long = 'x'.repeat(33);
      expect(
        extractOpenerVariant({ agentName: 'opening_composer', meta: { openerVariant: long } }),
      ).toBeNull();
    });
  });

  describe('thresholds match the documented defaults', () => {
    // Safety net — if anyone changes the defaults without updating
    // AGENTS.md / RUNBOOK.md, this test fails loudly.
    it('exports T_SAFETY = 0.8 by default', () => {
      expect(T_SAFETY).toBeCloseTo(0.8, 5);
    });
    it('exports T_SEMI_AUTO_GOALFIT = 0.6 by default', () => {
      expect(T_SEMI_AUTO_GOALFIT).toBeCloseTo(0.6, 5);
    });
    it('exports T_AUTO_GOALFIT = 0.75 by default', () => {
      expect(T_AUTO_GOALFIT).toBeCloseTo(0.75, 5);
    });
  });
});
