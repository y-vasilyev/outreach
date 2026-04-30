import { Errors } from '@nosquare/shared/errors';

import type { AnyAgent } from './types.js';

/**
 * Heterogeneous registry of agents keyed by their `name`.
 *
 * Agents have wildly different IO shapes; we keep the value type as
 * `Agent<any, any>` (aliased to `AnyAgent`) and expect callers to know which
 * agent they're requesting. The AgentRunner re-validates input/output via
 * the agent's zod schemas so this isn't a hole in safety.
 */
class AgentRegistry {
  private readonly byName = new Map<string, AnyAgent>();

  register(agent: AnyAgent): void {
    if (this.byName.has(agent.name)) {
      // Re-registration is fine in dev/HMR; warn but overwrite.
      // (Caller code is in agents/index.ts which runs once at import.)
    }
    this.byName.set(agent.name, agent);
  }

  get(name: string): AnyAgent {
    const a = this.byName.get(name);
    if (!a) throw Errors.notFound('agent', name);
    return a;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  all(): AnyAgent[] {
    return Array.from(this.byName.values());
  }

  clear(): void {
    this.byName.clear();
  }
}

export const agentRegistry = new AgentRegistry();
