import { getPrisma } from '@nosquare/db';
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_DEFAULTS,
  type FeatureFlagKey,
} from '@nosquare/shared';

import { env } from '../env.js';
import { getFeatureFlags } from '../feature-flags.js';

/**
 * Admin-facing feature-flag service (runtime-feature-flags M3).
 *
 * Reads the resolved (env-force > DB > default) state from the runtime
 * accessor and annotates each flag with a non-blocking "readiness" hint —
 * whether the external prerequisites a feature needs at runtime are present
 * (S3 creds, endpoints + TG accounts, a non-empty blogger catalog). The hint
 * NEVER blocks a toggle; it just warns an operator that an enabled feature may
 * degrade. The evaluator is best-effort: a query failure reports `ready:false`
 * with a neutral hint instead of throwing (so the list never 500s).
 */

export interface FeatureFlagReadiness {
  ready: boolean;
  hint?: string;
}

export interface FeatureFlagView {
  key: FeatureFlagKey;
  enabled: boolean;
  description: string;
  readiness: FeatureFlagReadiness;
}

/** S3 prerequisites for `object_storage` — pure env check, never throws. */
function objectStorageReadiness(): FeatureFlagReadiness {
  const ok = Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY && env.S3_BUCKET);
  return ok
    ? { ready: true }
    : { ready: false, hint: 'не заданы S3_* (endpoint, ключи, bucket) — медиа не сохранится' };
}

/**
 * `agency_sourcing` needs at least one enabled LLM endpoint AND at least one
 * TG account to actually run outreach. Best-effort: on a query error report
 * not-ready with a neutral hint rather than throwing.
 */
async function agencySourcingReadiness(): Promise<FeatureFlagReadiness> {
  try {
    const prisma = getPrisma();
    const [endpoints, tgAccounts] = await Promise.all([
      prisma.endpoint.count({ where: { enabled: true } }),
      prisma.tgAccount.count(),
    ]);
    if (endpoints === 0 && tgAccounts === 0) {
      return { ready: false, hint: 'нет активных endpoint и TG-аккаунтов' };
    }
    if (endpoints === 0) return { ready: false, hint: 'нет активного endpoint' };
    if (tgAccounts === 0) return { ready: false, hint: 'нет TG-аккаунтов' };
    return { ready: true };
  } catch {
    return { ready: false, hint: 'не удалось проверить готовность' };
  }
}

/** `blogger_matching` needs a non-empty profile catalog. Best-effort. */
async function bloggerMatchingReadiness(): Promise<FeatureFlagReadiness> {
  try {
    const prisma = getPrisma();
    const profiles = await prisma.bloggerProfile.count();
    if (profiles === 0) {
      return { ready: false, hint: 'каталог пуст — сначала соберите профили' };
    }
    return { ready: true };
  } catch {
    return { ready: false, hint: 'не удалось проверить готовность' };
  }
}

/**
 * Compute the readiness hint for a single flag. Never throws.
 * `campaign_types` is always ready (no external prerequisites).
 */
export async function evaluateReadiness(key: FeatureFlagKey): Promise<FeatureFlagReadiness> {
  switch (key) {
    case 'object_storage':
      return objectStorageReadiness();
    case 'agency_sourcing':
      return agencySourcingReadiness();
    case 'blogger_matching':
      return bloggerMatchingReadiness();
    case 'campaign_types':
      return { ready: true };
    default:
      return { ready: true };
  }
}

export const featureFlagsService = {
  /** List every known flag with its resolved state, description, and readiness. */
  async list(): Promise<FeatureFlagView[]> {
    const prisma = getPrisma();
    const rows = await prisma.featureFlag.findMany({
      select: { key: true, description: true },
    });
    const descByKey = new Map(rows.map((r) => [r.key, r.description]));
    const ff = getFeatureFlags();

    return Promise.all(
      FEATURE_FLAG_KEYS.map(async (key) => ({
        key,
        enabled: ff.get(key),
        description: descByKey.get(key) ?? '',
        readiness: await evaluateReadiness(key),
      })),
    );
  },

  /**
   * Set a flag's enabled state and record who changed it. The caller is
   * responsible for the audit_log entry + cache invalidation publish.
   */
  async setEnabled(key: FeatureFlagKey, enabled: boolean, updatedById: string | null) {
    const prisma = getPrisma();
    return prisma.featureFlag.upsert({
      where: { key },
      update: { enabled, updatedById },
      create: { key, enabled, updatedById, description: '' },
    });
  },
};

export { FEATURE_FLAG_DEFAULTS };
