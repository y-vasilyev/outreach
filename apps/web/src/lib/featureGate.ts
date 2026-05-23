import { ApiError } from './api';

/**
 * Agency-sourcing-matching endpoints are flag-gated server-side
 * (ENABLE_CAMPAIGN_TYPES / ENABLE_AGENCY_SOURCING / ENABLE_OBJECT_STORAGE /
 * ENABLE_BLOGGER_MATCHING, default off). When a flag is off the route is not
 * registered, so Fastify answers 404. The UI must degrade to a friendly
 * "feature not enabled" state instead of crashing.
 *
 * `isFeatureOff` recognises that case. A flag-off route is simply not
 * registered, so Fastify answers with its default 404 shape
 * (`{ statusCode, error: 'Not Found', message }`) which our API client maps to
 * code `HTTP_404`. A genuinely-missing entity behind a registered route throws
 * the application `AppError` whose body carries a machine-readable
 * `code: 'NOT_FOUND'`. We must NOT treat the latter as "feature off" — a real
 * missing id should render a not-found state, not the disabled-feature panel.
 *
 * So: only a 404 that is NOT an application NOT_FOUND counts as feature-off.
 */
export function isFeatureOff(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 404 && error.code !== 'NOT_FOUND';
  }
  return false;
}
