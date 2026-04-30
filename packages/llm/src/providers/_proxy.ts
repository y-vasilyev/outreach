/**
 * Lazy proxy-agent helper. We don't want to construct a ProxyAgent eagerly
 * for every endpoint — the LLM package is also imported in places that
 * never make a network call (tests, type-only references). Cache one agent
 * per proxy URL so multiple endpoint calls reuse the same connection pool.
 */
import { ProxyAgent } from 'undici';

const cache = new Map<string, ProxyAgent>();

export function getProxyAgent(proxyUrl: string | undefined): ProxyAgent | undefined {
  if (!proxyUrl) return undefined;
  let agent = cache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    cache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * Returns extra fetch options to merge into a `fetch(url, opts)` call when a
 * proxy is configured. Returns `{}` when no proxy. Using the keep-alive
 * pool from undici gives us connection reuse + retries via the dispatcher
 * config.
 */
export function fetchProxyOpts(proxyUrl: string | undefined): { dispatcher?: unknown } {
  const a = getProxyAgent(proxyUrl);
  return a ? { dispatcher: a } : {};
}
