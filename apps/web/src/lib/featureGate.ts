import { ApiError } from './api';

/**
 * Agency-sourcing-matching endpoints are flag-gated server-side
 * (ENABLE_CAMPAIGN_TYPES / ENABLE_AGENCY_SOURCING / ENABLE_OBJECT_STORAGE /
 * ENABLE_BLOGGER_MATCHING, default off). When a flag is off the route is not
 * registered, so Fastify answers 404. The UI must degrade to a friendly
 * "feature not enabled" state instead of crashing.
 *
 * `isFeatureOff` recognises that case: a 404 (route absent) or a network error
 * (API not reachable) on an endpoint whose feature may be disabled.
 */
export function isFeatureOff(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 404;
  }
  return false;
}
