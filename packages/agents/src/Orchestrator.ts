/**
 * Pipelines as data. Steps are pure-ish: they read from a `PipelineState.values`
 * map, optionally call an agent through the runner, and write results back.
 *
 * The orchestrator does not perform side effects (DB writes, queue puts) —
 * those live in the worker that owns the pipeline output. This keeps pipelines
 * unit-testable with a mocked AgentRunner.
 */

import type { AgentRunner, RunCtxIds } from './AgentRunner.js';

export interface PipelineState extends RunCtxIds {
  values: Record<string, unknown>;
}

export type PipelineStep =
  | {
      kind: 'agent';
      name: string;
      /** Key in `state.values` to write the agent output to. Defaults to `name`. */
      output?: string;
      /** Build the agent input from current pipeline state. */
      input: (state: PipelineState) => unknown;
      /** Optional gate: if returns false, step is skipped. */
      if?: (state: PipelineState) => boolean;
    }
  | {
      kind: 'fn';
      name: string;
      run: (state: PipelineState) => Promise<void> | void;
      if?: (state: PipelineState) => boolean;
    }
  | {
      kind: 'switch';
      on: (state: PipelineState) => string;
      cases: Record<string, PipelineStep[]>;
      /** Optional default branch when `on()` returns an unknown key. */
      default?: PipelineStep[];
    };

export class Orchestrator {
  constructor(private readonly runner: AgentRunner) {}

  async run(steps: PipelineStep[], state: PipelineState): Promise<PipelineState> {
    for (const step of steps) {
      await this.runStep(step, state);
    }
    return state;
  }

  private async runStep(step: PipelineStep, state: PipelineState): Promise<void> {
    if (step.kind === 'agent') {
      if (step.if && !step.if(state)) return;
      const input = step.input(state);
      const out = await this.runner.run(step.name, input, ctxIds(state));
      const key = step.output ?? step.name;
      state.values[key] = out;
      return;
    }
    if (step.kind === 'fn') {
      if (step.if && !step.if(state)) return;
      await step.run(state);
      return;
    }
    if (step.kind === 'switch') {
      const which = step.on(state);
      const branch = step.cases[which] ?? step.default;
      if (!branch) return;
      for (const inner of branch) {
        await this.runStep(inner, state);
      }
      return;
    }
  }
}

function ctxIds(state: PipelineState): RunCtxIds {
  const ids: RunCtxIds = {};
  if (state.channelId !== undefined) ids.channelId = state.channelId;
  if (state.contactId !== undefined) ids.contactId = state.contactId;
  if (state.conversationId !== undefined) ids.conversationId = state.conversationId;
  if (state.campaignId !== undefined) ids.campaignId = state.campaignId;
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Pre-defined pipelines                                                      */
/* -------------------------------------------------------------------------- */

import { runRegexCandidates, type RegexCandidate } from './regex.js';

/**
 * extractContacts — `channel.status=scraped` → contacts in DB.
 *
 * Steps 3 (`regex_extract`) and 5 (`dedupe_normalize`) are deterministic
 * helpers; the worker provides side-effect glue (writing contact rows).
 */
export const extractContactsPipeline: PipelineStep[] = [
  {
    kind: 'agent',
    name: 'channel_analyzer',
    output: 'channel_analysis',
    input: (s) => s.values.channel_analyzer_input,
  },
  {
    kind: 'fn',
    name: 'red_flags_gate',
    run: (s) => {
      const a = s.values.channel_analysis as
        | { red_flags?: unknown[] }
        | undefined;
      if (a?.red_flags && Array.isArray(a.red_flags) && a.red_flags.length > 0) {
        s.values.disqualified = true;
      }
    },
  },
  {
    kind: 'fn',
    name: 'regex_extract',
    if: (s) => !s.values.disqualified,
    run: (s) => {
      const inp = s.values.channel_analyzer_input as
        | { description?: string; recent_posts?: Array<{ text?: string }>; links?: string[] }
        | undefined;
      const text = collectText(inp);
      s.values.regex_candidates = runRegexCandidates(text);
    },
  },
  {
    kind: 'agent',
    name: 'contact_extractor',
    output: 'contacts',
    if: (s) => !s.values.disqualified,
    input: (s) => ({
      ...(s.values.contact_extractor_input as Record<string, unknown>),
      regex_candidates: (s.values.regex_candidates as RegexCandidate[]) ?? [],
    }),
  },
  {
    kind: 'fn',
    name: 'dedupe_normalize',
    if: (s) => !s.values.disqualified,
    // ContactExtractor itself dedups + normalizes via post-process, but we keep
    // this hook so workers can layer DB-level dedup (cross-channel etc.).
    run: () => {
      // Worker overrides this step in practice. No-op here.
    },
  },
];

function collectText(
  inp:
    | { description?: string; recent_posts?: Array<{ text?: string }>; links?: string[] }
    | undefined,
): string {
  if (!inp) return '';
  const parts: string[] = [];
  if (inp.description) parts.push(inp.description);
  if (Array.isArray(inp.recent_posts)) {
    for (const p of inp.recent_posts) if (p?.text) parts.push(p.text);
  }
  if (Array.isArray(inp.links)) parts.push(inp.links.join(' '));
  return parts.join('\n\n');
}

/**
 * outreach_first_message — campaign dispatcher selected a contact.
 * Worker-side glue:
 *   - Reads contact / channel from DB and assembles agent inputs into
 *     `state.values.*_input` keys.
 *   - After this pipeline, persists suggestion rows / queues tg-send.
 */
export const outreachFirstMessagePipeline: PipelineStep[] = [
  {
    kind: 'agent',
    name: 'contact_prioritizer',
    output: 'priority',
    if: (s) => Boolean(s.values.contact_prioritizer_input),
    input: (s) => s.values.contact_prioritizer_input,
  },
  {
    kind: 'agent',
    name: 'channel_analyzer',
    output: 'channel_analysis',
    if: (s) => Boolean(s.values.channel_analyzer_input),
    input: (s) => s.values.channel_analyzer_input,
  },
  {
    kind: 'agent',
    name: 'approach_strategist',
    output: 'strategy',
    input: (s) => s.values.approach_strategist_input,
  },
  {
    kind: 'agent',
    name: 'opening_composer',
    output: 'openings',
    input: (s) => s.values.opening_composer_input,
  },
  {
    kind: 'fn',
    name: 'safety_filter_each_variant',
    run: async (s) => {
      // Fans out per variant — but Orchestrator only owns sequencing.
      // Worker glues this: feeds each variant to safety_filter and stores the
      // result. We keep a placeholder so pipelines stay declarative.
      s.values.safety_pending = true;
    },
  },
];

/**
 * on_inbound — message arrived from contact.
 */
export const onInboundPipeline: PipelineStep[] = [
  {
    kind: 'agent',
    name: 'conversation_summarizer',
    output: 'summary',
    if: (s) => {
      const len = s.values.history_len as number | undefined;
      return typeof len === 'number' && len > 0 && len % 20 === 0;
    },
    input: (s) => s.values.conversation_summarizer_input,
  },
  {
    kind: 'agent',
    name: 'intent_classifier',
    output: 'intent',
    input: (s) => s.values.intent_classifier_input,
  },
  {
    kind: 'agent',
    name: 'handoff_decider',
    output: 'handoff',
    input: (s) => ({
      ...(s.values.handoff_decider_input as Record<string, unknown>),
      intent: s.values.intent,
    }),
  },
  {
    kind: 'switch',
    on: (s) => {
      const h = s.values.handoff as { action?: string } | undefined;
      return h?.action ?? 'ai_continue';
    },
    cases: {
      operator_now: [
        {
          kind: 'fn',
          name: 'mark_operator_now',
          run: (s) => {
            s.values.next = { action: 'operator_now' };
          },
        },
      ],
      ai_suggest_only: [
        {
          kind: 'agent',
          name: 'reply_composer',
          output: 'replies',
          input: (s) => s.values.reply_composer_input,
        },
        {
          kind: 'fn',
          name: 'mark_assist',
          run: (s) => {
            s.values.next = { action: 'ai_suggest_only' };
          },
        },
      ],
      ai_continue: [
        {
          kind: 'agent',
          name: 'reply_composer',
          output: 'replies',
          input: (s) => s.values.reply_composer_input,
        },
        {
          kind: 'agent',
          name: 'next_action_planner',
          output: 'plan',
          input: (s) => s.values.next_action_planner_input,
        },
        {
          kind: 'fn',
          name: 'mark_continue',
          run: (s) => {
            s.values.next = { action: 'ai_continue' };
          },
        },
      ],
    },
  },
];

/**
 * followup_check — cron pass over silent active conversations.
 * Worker computes `send_followup_at` and persists / schedules.
 */
export const followupCheckPipeline: PipelineStep[] = [
  {
    kind: 'agent',
    name: 'conversation_summarizer',
    output: 'summary',
    if: (s) => Boolean(s.values.conversation_summarizer_input),
    input: (s) => s.values.conversation_summarizer_input,
  },
  {
    kind: 'agent',
    name: 'next_action_planner',
    output: 'plan',
    input: (s) => s.values.next_action_planner_input,
  },
  {
    kind: 'agent',
    name: 'reply_composer',
    output: 'replies',
    if: (s) => {
      const plan = s.values.plan as { next_action?: string } | undefined;
      return plan?.next_action === 'send_followup_at' || plan?.next_action === 'send_now';
    },
    input: (s) => s.values.reply_composer_input,
  },
];
