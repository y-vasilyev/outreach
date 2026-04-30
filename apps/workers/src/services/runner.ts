import { AgentRunner } from '@nosquare/agents';
import { getPrisma } from '@nosquare/db';
import { resolveEndpoint } from './endpoint-resolver.js';
import { logger } from '../logger.js';

let _runner: AgentRunner | undefined;
export function getRunner(): AgentRunner {
  if (!_runner) {
    _runner = new AgentRunner({
      prisma: getPrisma(),
      endpointResolver: resolveEndpoint,
      logger,
    });
  }
  return _runner;
}
