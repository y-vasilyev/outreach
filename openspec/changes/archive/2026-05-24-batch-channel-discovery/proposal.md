## Why

Сейчас `POST /discovery/search` принимает одну нишу и синхронно прогоняет её через Yandex Search → нормализацию → создание `channel(status='new')` → enqueue `channel-scrape`. Для пилота agency_sourcing нужно собрать ~200 блогеров (`Batch discovery (массовый прогон по списку ниш...)`. на 200 ниш × ~5 сек = 17+ минут — синхронный HTTP-запрос таймаутит (fastify default 30s). Оператору неудобно собирать партии вручную: делать 200 запросов в админке нереально.

Нужен async batch flow: один запрос на массив ниш, фоновое исполнение, отдельный endpoint для статуса. Per-niche pipeline (search → normalize → create/skip channel → enqueue scrape) — те же ~30 строк, что в `discoveryService.search`, **намеренно продублированы** в воркере (см. design.md Decision 1: cross-app boundary, helper-extraction не оправдан для 30 строк).

## What Changes

- **Schema** `DiscoveryBatchInputZ` / `DiscoveryBatchZ` / `DiscoveryBatchStatusZ` в `@nosquare/shared`. Input: `{ queries: string[1..50], platform?, limit_per_query? }`. Output (status): `{ id, status, createdAt, completedAt?, results: per-query[], totals }`.
- **Migration**: новая таблица `DiscoveryBatch` (`id`, `queries Json`, `platform String?`, `limitPerQuery Int`, `status enum(pending|running|done|failed)`, `createdById`, `createdAt`, `completedAt`, `summary Json` — суммирует per-query результаты).
- **Worker queue** `discovery-batch`: для каждой ниши выполняет per-niche pipeline (search → extractCandidates → findUnique/create channel с race-guard → enqueue channel-scrape) — те же ~30 строк, что в single-search API сервисе, продублированы намеренно (см. design.md Decision 1). Накапливает per-query результаты в `DiscoveryBatch.summary`. Между нишами небольшая пауза (rate-limit-friendly для Yandex API). Throw в одной нише → пишем `error` в её summary, идём дальше (failure isolation). Resumable: при crash-recovery skips ниши с `done: true`.
- **API**:
  - `POST /discovery/batch` — создаёт `DiscoveryBatch(status='pending')`, ставит worker job, возвращает `{ id }`. Audited.
  - `GET /discovery/batch/:id` — возвращает `DiscoveryBatchStatus` (full per-query). Admin/operator. Не audited (read-only, polling-friendly).
  - `GET /discovery/batch` — список последних 20 batches с агрегатами. Admin/operator.
- **Гейт**: за тем же runtime-флагом `channel_discovery` (off by default), что и single search.
- **Тесты**:
  - Unit: `discoveryBatchService.create/get/list` (mocked queues + prisma).
  - Worker: processBatch обрабатывает 3 ниши, одна падает → status `done` с per-query error для упавшей, остальные success.

## Capabilities

### New Capabilities
Нет.

### Modified Capabilities
- `channel-discovery`: дельта-спека добавляет requirement про batch flow поверх существующего single-query.

## Impact

- **Файлы**:
  - `packages/shared/src/schemas/discovery.ts` — новые `DiscoveryBatchInputZ` / `DiscoveryBatchStatusZ`.
  - `packages/shared/src/realtime.ts` — добавить queue name `'discovery-batch'` в `QueueNames` enum.
  - `packages/db/prisma/schema.prisma` — model `DiscoveryBatch` + enum.
  - `packages/db/prisma/migrations/9d_discovery_batch/migration.sql` — новая.
  - `apps/api/src/services/discovery-batch.ts` — новый сервис.
  - `apps/api/src/routes/discovery.ts` — добавить три endpoint'а.
  - `apps/api/src/queues.ts` — регистрация очереди `discovery-batch`.
  - `apps/workers/src/queues/discovery-batch.ts` — новый worker handler.
  - `apps/workers/src/index.ts` — регистрация worker'а.
  - `apps/web/src/features/discovery/` — UI-стаб с формой (multi-niche textarea) + страница статуса. NB: scope этого change'а — backend; UI минимальный, можно расширить в follow-up.
  - `CHANGELOG.md` — `### Added`.
  - `openspec/specs/channel-discovery/spec.md` — дельта.
- **Прод-деплой**: миграция БД + рестарт API/workers. `channel_discovery` флаг должен быть включён.
- **Риски**: rate-limit от Yandex API при 200 ниш одновременно — митигация: between-query задержка 1 сек, max concurrency 1 в воркере. Если Yandex API key exhausted — каждая ниша вернёт ошибку, batch'у `failed`.
- **Тесты**: ≥ 70% веток в новых файлах. Smoke на чистой БД (миграция 9d применилась, таблица доступна).
