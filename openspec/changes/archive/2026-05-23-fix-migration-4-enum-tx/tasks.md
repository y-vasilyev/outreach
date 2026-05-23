## 1. Подготовка

- [x] 1.1 Сверить текущее состояние `_prisma_migrations` на dev-БД (ожидается: таблица отсутствует, схема накатана через `db push`).
- [x] 1.2 Снять локальную копию `packages/db/prisma/migrations/4_chat_autonomous_modes/migration.sql` для diff-сравнения.

## 2. Migration 4 — убрать enum-зависимый backfill

- [x] 2.1 Из `packages/db/prisma/migrations/4_chat_autonomous_modes/migration.sql` удалить строки 53–54:
  - `UPDATE "Conversation" SET "mode" = 'semi_auto' WHERE "mode" = 'auto';`
  - `UPDATE "Campaign" SET "defaultMode" = 'semi_auto' WHERE "defaultMode" = 'auto';`
- [x] 2.2 Добавить в начало файла комментарий-памятку: «DO NOT use `semi_auto` in this migration — Postgres forbids referring to a newly-added enum value in the same transaction. Backfill lives in migration 9a_chat_modes_backfill_semi_auto».
- [x] 2.3 Убедиться, что остальная часть миграции 4 (ALTER TYPE, ADD COLUMN, JSONB ajtbd backfill) осталась нетронутой.

## 3. Migration 9a — backfill в отдельной транзакции

- [x] 3.1 Создать директорию `packages/db/prisma/migrations/9a_chat_modes_backfill_semi_auto/`.
- [x] 3.2 Положить туда `migration.sql` со следующими `UPDATE`-инструкциями (идемпотентные, безопасные на пустой БД):
  - `UPDATE "Conversation" SET "mode" = 'semi_auto' WHERE "mode" = 'auto';`
  - `UPDATE "Campaign" SET "defaultMode" = 'semi_auto' WHERE "defaultMode" = 'auto';`
- [x] 3.3 Добавить в начало файла комментарий, объясняющий назначение миграции и почему backfill выделен (ссылка на change `fix-migration-4-enum-tx`).

## 4. Smoke-проверка на чистой БД

- [x] 4.1 Поднять временный Postgres-контейнер (`docker run --rm -d ...` или второй сервис в compose) с пустой БД.
- [x] 4.2 Прогнать `pnpm db:migrate:deploy` (через `DATABASE_URL`, указывающий на временную БД).
- [x] 4.3 Убедиться: все 11 миграций отработали, ошибок `unsafe use of new value 'semi_auto'` нет, в `ConversationMode` оба значения присутствуют, `_prisma_migrations` содержит 11 записей.
- [x] 4.4 Прогнать `pnpm db:seed` (опционально, для верификации цельности).
- [x] 4.5 Завершить и удалить временный контейнер.

## 5. Регрессия

- [x] 5.1 `pnpm typecheck` зелёный.
- [x] 5.2 `pnpm lint` зелёный.
- [x] 5.3 `pnpm test` зелёный (миграции не должны влиять на unit-тесты, но проверяем).

## 6. Документация

- [x] 6.1 Обновить `CHANGELOG.md`: добавить запись `### Fixed` в секцию `## Unreleased`, описывающую hotfix.
- [x] 6.2 Создать `openspec/changes/fix-migration-4-enum-tx/RUNBOOK.md` с разделёнными сценариями: (a) свежий кластер без `_prisma_migrations` — действий не требуется; (b) кластер с **failed** строкой миграции 4 (`finished_at IS NULL`) — `prisma migrate resolve --rolled-back "4_chat_autonomous_modes"` + `migrate deploy`, либо `db:reset` на disposable; (c) локальная БД с **applied** миграцией 4 — `migrate deploy` (drift-warning + только 9a) или `pnpm db:reset`. Без `--rolled-back` для applied — Prisma откажет.

## 7. Ревью и архив

- [x] 7.1 Запросить ревью через Codex (синхронно через `codex-companion.mjs task`, не через rescue/background — известная нестабильность плагина).
- [x] 7.2 Применить замечания. 4 раунда: round 1 → 2 blocker + 3 suggestion + 2 nit; round 2 → 3 doc warning; round 3 → 3 doc nit; round 4 → no findings, approve.
- [x] 7.3 После аппрува пользователем — `openspec archive fix-migration-4-enum-tx`.
- [x] 7.4 Закоммитить итоговое состояние одним PR-style коммитом с сообщением `fix(db): split enum-add and backfill for semi_auto migration (release blocker)`.
