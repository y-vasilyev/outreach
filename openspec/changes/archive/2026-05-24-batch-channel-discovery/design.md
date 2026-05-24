## Context

Single-niche `POST /discovery/search` уже работает и проверен (см. `2026-05-21-channel-discovery-search`). Узкое место — синхронность: один HTTP-запрос на одну нишу, web таймаутит на ~10 запросах подряд. Batch endpoint решает эту проблему через async-queue.

## Goals / Non-Goals

**Goals:**
- Один запрос → массивная обработка → доступ к статусу через polling.
- Сохранить семантику single-search pipeline (search → normalize → create/skip channel → enqueue scrape) — но реализовать локально в воркере, без shared-helper'а (см. Decision 1).
- Failure isolation: одна сломанная ниша не валит весь batch.
- Rate-limit aware: пауза между нишами, max concurrency 1 (Yandex API).

**Non-Goals:**
- Не делаем WebSocket-стриминг прогресса (polling достаточен для оператора).
- Не вводим cancellation в этой итерации (если кому-то надо — отдельный change).
- Не делаем парсинг "auto-ratemate" по 404/429 от Yandex (если ключ исчерпан — каждая ниша вернёт `error`, batch'у `failed`/`done` с per-query errors).
- UI ограничен формой ввода + страницей статуса. Полноценный «job manager» — follow-up.

## Decisions

### Decision 1: Worker дублирует per-niche pipeline, не shared core helper

**Что:** Per-niche логика (search → extractCandidates → findUnique/create channel + race-guard → enqueue channel-scrape, ~30 строк) дублируется в `apps/workers/src/queues/discovery-batch.ts` и `apps/api/src/services/discovery.ts`. Никакого нового shared helper.

**Почему:**
- API и worker — разные apps; импорт `apps/api/src/services/...` из `apps/workers/...` нарушает монорепо boundary (cross-app cyclic deps в худшем случае).
- Выделение helper'а в `packages/platforms/src/discovery/` или `packages/db/` требует параметризации Prisma/queue зависимостей через adapter, что для 30 строк overkill.
- Дублирование задокументировано в шапке worker'а с инструкцией факторить когда логика вырастет (≥ 2 разных шага).

**Альтернативы (отвергнуты):**
- *Pure helper в packages/platforms*: добавил бы зависимость на `@nosquare/db` в платформенный пакет, либо параметризацию channelStore-adapter'а — overkill.
- *Worker импортирует API service*: cross-app dep, плохо.
- *HTTP self-call worker → API*: ещё хуже.

### Decision 2: Per-query rate-limit pause

**Что:** В воркере между нишами `setTimeout(1000)`. Yandex Search API лимит ~10 RPS для free-tier, мы делаем 1 RPS — комфортно.

**Почему:** Запас под параллельные single-query вызовы от других операторов + bursting защита.

### Decision 3: Per-query failure isolation

**Что:** В цикле — try/catch вокруг per-niche pipeline. Любая ошибка пишется в `summary.queries[i].error = '<message>'`, batch продолжается. После цикла batch ставится в `status='done'` (даже если все ниши упали), но `summary.totals.errored > 0`. Pre-loop setup (decryptJson, client construction) обёрнут отдельным try/catch, который маркит row `failed` с `fatalError` — никаких стуковых `running`.

**Почему:** Оператор видит, что N ниш отработало, M упало с конкретным reason'ом, может ретраить только проблемные.

### Decision 4: Хранение результатов в `summary: Json` (не отдельная таблица)

**Что:** Не делаем нормализованную таблицу `DiscoveryBatchResult`. Структура `summary` — `{ totals: { created, alreadyKnown, errored, perQueryCount }, queries: [{ query, status, candidates: [...], created, alreadyKnown, error? }] }`.

**Почему:**
- Один batch — небольшая JSON-строка (200 ниш × 50 candidates × малая запись = ~< 1 MB). PostgreSQL JSON без проблем.
- Нормализация добавляет код без чёткой бизнес-нужды (по результату batch не делаются queries).
- Если в будущем понадобится индексировать кандидатов отдельно — можно мигрировать.

### Decision 5: Atomic claim с stale-lock gate

**Что:** Worker делает single-call `updateMany({ where: { id, OR: [{status:'pending'}, {status:'running', updatedAt:{lt: NOW - 2min}}], data: { status:'running' } })` для забирания row'а. Если `count !== 1` — другой worker уже владеет, bail out.

**Почему:**
- Защита от concurrent claim (два BullMQ retry'я одновременно): `updateMany` атомарен в Postgres.
- Защита от stuck `running` после crash: stale-lock gate (`updatedAt < NOW - 2min`) даёт recover'у-worker'у забрать lock через 2 мин после последнего heartbeat'а первого.
- Heartbeat — это `prisma.discoveryBatch.update(...)` после каждой ниши; обновляет `@updatedAt`. Пока live worker процессит ниши быстрее 2 мин — concurrent retry видит свежий updatedAt и bails.
- Per-niche loop skip'ает `done: true` — recovery после crash продолжает с того места, где предыдущий worker остановился.

**Альтернативы:**
- *Только `pending`*: безопасно, но crash-recovery невозможна без separate sweep job (overkill для пилота).
- *Lease/owner token*: добавил бы `lockedBy`/`lockedAt` columns. Эквивалент по эффекту, требует миграции БД и больше кода. `updatedAt` уже есть.
- *SELECT FOR UPDATE*: tighter lock, но требует raw SQL через Prisma + transaction. Stale-lock через updatedAt — простой и достаточный паттерн для нашей нагрузки.

### Decision 6: Worker concurrency = 1 для очереди

**Что:** В `apps/workers/src/index.ts` при регистрации worker'а `discovery-batch` ставим `concurrency: 1`.

**Почему:** Несколько одновременных batches × несколько ниш = burst к Yandex. Безопаснее последовательно.

## Risks / Trade-offs

- **[Риск] Batch занимает 30+ минут**, оператор закрывает вкладку. → Митигация: `GET /discovery/batch/:id` всегда доступен, статус сохраняется.
- **[Риск] Worker крашится в середине batch'а** → row остаётся `running`. → Митигация: BullMQ stalled-detection (default 30s) повторно ставит job; новый worker делает атомарный claim с stale-lock gate (`status='running' AND updatedAt < NOW() - 2min`) — забирает stale lock, читает summary, **skip'ает уже `done: true` ниши** и доделывает остальные. Pre-loop setup (decryptJson, client construction) обёрнут отдельным try/catch, который пишет `fatalError` в summary и помечает `failed` — никаких висящих `running` от неожиданных throw'ов.

- **[Риск] Concurrent claim race**: два worker'а параллельно делают `updateMany`. → Митигация: stale-lock gate (status='running' AND updatedAt > 2min back) гарантирует, что активный worker (heartbeat через `updatedAt` после каждой ниши) не теряет lock; concurrent retry видит свежий updatedAt и bails out. Window race возможна только если ниша занимает > 2 мин (что само по себе bug-condition, handled через client timeout в follow-up).
- **[Trade-off] In-DB JSON summary** — невозможно SQL-индексировать кандидатов; для отчётов придётся читать целиком. Принимаем.
- **[Trade-off] UI минимален** — оператор не видит per-candidate breakdown за batch иначе как через API. Следующая итерация добавит таблицу.

## Migration Plan

1. Schema + migration `9d_discovery_batch`.
2. Shared schemas (`DiscoveryBatchInputZ`, `*ListItemZ`, `*StatusZ`, `*SummaryZ`).
3. API service `discovery-batch.ts` (create / get / list).
4. Worker handler — per-niche pipeline duplicated (Decision 1) + atomic-claim with stale-lock gate (Decision 4) + outer try/catch around setup.
5. Routes + queues регистрация.
6. Min UI — deferred follow-up.
7. Тесты.
8. Регрессия (typecheck/test/smoke на чистой БД).
9. Codex review.
10. Архив + коммит.

**Rollback:** standard `git revert` + миграция отката (drop таблицы `DiscoveryBatch`). Никаких прод-побочек.

## Open Questions

- Закрыто (см. Decision 1): код per-niche pipeline дублируется в воркере, не в shared helper. Если объём вырастет — выделим в `packages/platforms/src/discovery/` с adapter-параметризацией Prisma/queue.
