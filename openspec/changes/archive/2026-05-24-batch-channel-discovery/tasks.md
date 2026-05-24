## 1. Per-niche pipeline (deliberate duplication, NOT a shared core)

- [x] 1.1 (revised) Решено НЕ извлекать helper: worker дублирует ~30 строк per-niche логики из `apps/api/src/services/discovery.ts#search` (findUnique→create channel + race-guard + enqueue channel-scrape). Worker и API остаются независимыми, без cross-app coupling. Дублирование задокументировано в шапке `apps/workers/src/queues/discovery-batch.ts` с явной отсылкой и инструкцией факторить при росте кода.
- [x] 1.2 `apps/api/src/services/discovery.ts` не меняется (single-search контракт без правок).
- [x] 1.3 Существующие тесты `discovery.test.ts` и `discovery.e2e.test.ts` без изменений и остаются зелёными.

## 2. Shared schemas

- [x] 2.1 В `packages/shared/src/schemas/discovery.ts` добавить:
  - `DiscoveryBatchInputZ = z.object({ queries: z.array(z.string().min(2).max(300)).min(1).max(50), platform: PlatformZ.optional(), limit_per_query: z.number().int().min(1).max(50).default(20) })`.
  - `DiscoveryBatchSummaryZ` (total + per-query records).
  - `DiscoveryBatchStatusZ = z.object({ id, status, createdAt, completedAt?, summary })`.
  - Соответствующие `type` exports.

## 3. Миграция БД

- [x] 3.1 В `packages/db/prisma/schema.prisma` добавить `model DiscoveryBatch` + enum `DiscoveryBatchStatus`.
- [x] 3.2 `packages/db/prisma/migrations/9d_discovery_batch/migration.sql` — CREATE TABLE + CREATE TYPE.

## 4. API сервис

- [x] 4.1 `apps/api/src/services/discovery-batch.ts` с методами `create(input, userId)`, `get(id)`, `list()`. Использует `getPrisma()` + `getQueues()`.
- [x] 4.2 `getQueues()` (apps/api/src/queues.ts) — регистрация очереди `'discovery-batch'`.

## 5. Worker

- [x] 5.1 `apps/workers/src/queues/discovery-batch.ts` — handler: загружает `DiscoveryBatch` row, через atomic `updateMany` claim'ит `pending → running` ИЛИ `running (stale > 2 мин) → running` (stale-lock gate под crash-recovery), итерирует `queries`, для каждой выполняет per-niche pipeline (search → extractCandidates → findUnique/create channel с race-guard → enqueue channel-scrape), копит result в summary, skipает уже `done: true` ниши (resume после crash), на throw — записывает `error` per-query и продолжает. Totals пересчитываются детерминистически из queries. Post-claim setup и весь loop обёрнуты outer try/catch, который маркит `failed` + `fatalError` если что-то непредвиденно бросит. В конце — `status='done'`, `completedAt`. Между нишами `setTimeout(1000)` для rate-limit.
- [x] 5.2 Регистрация worker'а в `apps/workers/src/index.ts` с `concurrency: 1`.

## 6. API routes

- [x] 6.1 `apps/api/src/routes/discovery.ts` — добавить три endpoint'а:
  - `POST /discovery/batch` — `discoveryBatchService.create`, audited.
  - `GET /discovery/batch/:id` — `discoveryBatchService.get`. Read-only, не audited (polling-friendly).
  - `GET /discovery/batch` — `discoveryBatchService.list` (compact rows: totals only, без per-query candidates). Read-only, не audited.
- [x] 6.2 Все три гейтятся `requireFeature('channel_discovery')` + admin/operator role.

## 7. Web UI (минимальный) — DEFERRED follow-up

- [ ] 7.1 (deferred — follow-up change) `apps/web/src/features/discovery/BatchForm.vue` — textarea для списка ниш, platform-select, submit → `POST /discovery/batch` → redirect на `/discovery/batches/:id`.
- [ ] 7.2 (deferred — follow-up change) `apps/web/src/features/discovery/BatchStatus.vue` — polling каждые 5 сек, показывает status + summary.
- [ ] 7.3 (deferred — follow-up change) Регистрация маршрутов и линки из существующей discovery-страницы.

NB: backend готов и тестируется через REST напрямую. UI отложен, чтобы scope этого change'а оставался манageable. Будет отдельный change "Batch discovery web UI".

## 8. Тесты

- [x] 8.1 Unit: `apps/api/src/services/__tests__/discovery-batch.test.ts` — create/get/list (mocked prisma + queue).
- [x] 8.2 Worker: `apps/workers/src/__tests__/discoveryBatch.test.ts` — 3 ниши, одна падает → status `done`, error для упавшей.
- [x] 8.3 Регрессия: `pnpm typecheck && pnpm lint && pnpm test`.

## 9. Smoke на чистой БД

- [x] 9.1 Поднять временный Postgres, прогнать `prisma migrate deploy` — 14 миграций без ошибок.
- [x] 9.2 Проверить, что таблица `DiscoveryBatch` создалась.

## 10. Документация

- [x] 10.1 `CHANGELOG.md` → `## Unreleased → ### Added`: запись про batch flow.

## 11. Ревью и архив

- [x] 11.1 Codex review (синхронно).
- [x] 11.2 Применить замечания.
- [x] 11.3 `openspec archive batch-channel-discovery --yes`.
- [x] 11.4 Закоммитить: `feat(discovery): batch endpoint for multi-niche channel discovery`.
