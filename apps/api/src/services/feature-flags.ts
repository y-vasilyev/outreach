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

/**
 * S3 prerequisites for `object_storage` — pure env check, never throws.
 * Matches what `packages/storage` `loadStorageConfig()` actually requires:
 * access key, secret, bucket. `S3_ENDPOINT` is OPTIONAL (defaults to the AWS
 * regional endpoint), so it is NOT required here.
 */
function objectStorageReadiness(): FeatureFlagReadiness {
  const ok = Boolean(env.S3_ACCESS_KEY && env.S3_SECRET_KEY && env.S3_BUCKET);
  return ok
    ? { ready: true }
    : { ready: false, hint: 'не заданы S3_ACCESS_KEY/S3_SECRET_KEY/S3_BUCKET — медиа не сохранится' };
}

/**
 * `agency_sourcing` needs at least one enabled LLM endpoint AND at least one
 * USABLE outreach TG account (status `active`, role `outreach`/`both`) — the
 * runtime send paths filter on exactly that, so a banned/parser-only/cooldown
 * account must not count as "ready". Best-effort: on a query error report
 * not-ready with a neutral hint rather than throwing.
 */
async function agencySourcingReadiness(): Promise<FeatureFlagReadiness> {
  try {
    const prisma = getPrisma();
    const [endpoints, tgAccounts] = await Promise.all([
      prisma.endpoint.count({ where: { enabled: true } }),
      prisma.tgAccount.count({ where: { status: 'active', role: { in: ['outreach', 'both'] } } }),
    ]);
    if (endpoints === 0 && tgAccounts === 0) {
      return { ready: false, hint: 'нет активного endpoint и активного outreach TG-аккаунта' };
    }
    if (endpoints === 0) return { ready: false, hint: 'нет активного endpoint' };
    if (tgAccounts === 0) return { ready: false, hint: 'нет активного outreach TG-аккаунта' };
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
    const ff = getFeatureFlags();
    // Descriptions are best-effort: a failed read must not 500 the list
    // (it falls back to empty descriptions). Resolved state comes from the
    // in-memory accessor, not this query.
    let descByKey = new Map<string, string>();
    try {
      const rows = await getPrisma().featureFlag.findMany({
        select: { key: true, description: true },
      });
      descByKey = new Map(rows.map((r) => [r.key, r.description]));
    } catch {
      descByKey = new Map();
    }

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
   * Atomically set a flag's enabled state AND write the audit_log entry in one
   * transaction — so a change can never land without an audit (or vice versa).
   * Cross-process cache invalidation (publish) is the caller's responsibility,
   * done AFTER this commits (a failed publish only delays other processes
   * until their next reconnect-reload — it never un-does the audited change).
   */
  async setEnabled(key: FeatureFlagKey, enabled: boolean, updatedById: string | null) {
    const prisma = getPrisma();
    const [updated] = await prisma.$transaction([
      prisma.featureFlag.upsert({
        where: { key },
        update: { enabled, updatedById },
        create: { key, enabled, updatedById, description: '' },
      }),
      prisma.auditLog.create({
        data: {
          userId: updatedById,
          action: 'feature_flag.update',
          targetType: 'feature_flag',
          targetId: key,
          payload: { enabled },
        },
      }),
    ]);
    return updated;
  },
};

export { FEATURE_FLAG_DEFAULTS };
