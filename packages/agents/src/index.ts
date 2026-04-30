/**
 * Public surface of @nosquare/agents.
 *
 * Side-effect note: importing this module also imports `./agents/index.js`,
 * which registers all 12 agents into the singleton `agentRegistry`.
 */

export * from './types.js';
export * from './registry.js';
export * from './promptRender.js';
export * from './regex.js';
export * from './AgentRunner.js';
export * from './Orchestrator.js';

// Side-effect: register all agents.
export * from './agents/index.js';
