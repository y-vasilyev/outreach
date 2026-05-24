## 1. Shared helper

- [x] 1.1 Add `packages/shared/src/profile-staleness.ts` with `PROFILE_FIELD_TTL_DAYS`, `classifyProfileField`, `isProfileFieldStale`, `computeProfileFreshness`
- [x] 1.2 Re-export from `packages/shared/src/index.ts`
- [x] 1.3 Unit tests in `packages/shared/src/__tests__/profile-staleness.test.ts` covering: classification (each prefix + unknown), narrowed audience dims, TTL boundary, missing/unparseable `capturedAt`, fresh-non-contributing point ignored, no cross-section pollination, rate.<format> contributes to formats, observation-freshness semantics

## 2. API integration

- [x] 2.1 Extend `bloggerProfilesService.get` in `apps/api/src/services/blogger-profiles.ts` to compute and return `freshness`
- [x] 2.2 Update `apps/api/src/services/__tests__/blogger-profiles.test.ts` to assert the shape of `freshness` on a fresh vs stale fixture

## 3. Verification

- [x] 3.1 `pnpm typecheck && pnpm lint && pnpm test` green
- [x] 3.2 Codex review on the working-tree diff (iterate until approve)
- [x] 3.3 `openspec validate blogger-profile-freshness --strict` passes
- [ ] 3.4 Archive the change with `openspec archive blogger-profile-freshness`
