## Why

Миграция `4_chat_autonomous_modes` не применяется на свежей БД через `prisma migrate deploy`: в одном SQL-файле сначала `ALTER TYPE "ConversationMode" ADD VALUE 'semi_auto'`, потом `UPDATE ... SET mode='semi_auto'`. Postgres запрещает использовать новое enum-значение в той же транзакции, где оно добавлено — `ALTER TYPE ADD VALUE` становится видимым только после `COMMIT`. На свежем prod-окружении деплой упадёт; в dev мы обходили вручную через `psql`, и `_prisma_migrations` сейчас пуст (схема накатывалась через `db push`), так что история миграций защищать не нужно — путь чистый.

Это release-blocker №1 перед prod-запуском.

## What Changes

- **Migration 4** — убрать UPDATE-инструкции, использующие новое enum-значение `semi_auto`. Оставить: `ALTER TYPE ADD VALUE`, добавление колонок `Campaign.ajtbd`, `Conversation.qualityDecision`, `Conversation.lastSyncedAt`, и backfill JSON-структуры `ajtbd` (он не зависит от нового enum-значения).
- **Новая миграция 9a_chat_modes_backfill_semi_auto** — идемпотентный backfill в отдельной транзакции (где `semi_auto` уже закоммичено): `UPDATE Conversation SET mode='semi_auto' WHERE mode='auto'` и `UPDATE Campaign SET defaultMode='semi_auto' WHERE defaultMode='auto'`. На свежей БД no-op (нет строк со старым значением); на любой среде с legacy-данными корректно их подхватит. Префикс `9a_*` (а не `10_*`) выбран потому, что Prisma сортирует миграции лексикографически — `10_*` ушёл бы вперёд `1_*…9_*` (ASCII: `0` < `_`).
- **CHANGELOG**: запись в Unreleased → Fixed.
- **RUNBOOK** (в самой change-папке): инструкции для ops/команды по сценариям. Для свежего кластера без `_prisma_migrations` действий не требуется. Для кластеров, где предыдущая (broken) версия миграции 4 уже **упала** (`finished_at IS NULL`), требуется `prisma migrate resolve --rolled-back "4_chat_autonomous_modes"` + `migrate deploy`. Для локальных окружений с **applied** миграцией 4 достаточно `migrate deploy` (drift-warning + только новое 9a) или `pnpm db:reset`.

Это не функциональное изменение — поведение `auto`/`semi_auto` остаётся прежним. Это hotfix схемы миграций.

## Capabilities

### New Capabilities
Нет.

### Modified Capabilities
- `chat-autonomy-modes`: дельта-спека уточняет, что миграция enum-значения `semi_auto` выполняется в две физические транзакции (ADD VALUE отдельно от backfill), чтобы пройти `prisma migrate deploy` на свежем Postgres. Функциональные требования не меняются.

## Impact

- **Файлы**:
  - `packages/db/prisma/migrations/4_chat_autonomous_modes/migration.sql` — изменяется (удаляются строки 53–54 `UPDATE ... 'semi_auto'`).
  - `packages/db/prisma/migrations/9a_chat_modes_backfill_semi_auto/migration.sql` — новая.
  - `CHANGELOG.md` — секция `### Fixed` в `## Unreleased`.
  - `openspec/specs/chat-autonomy-modes/spec.md` — дельта по миграционному требованию.
- **Код приложений** — не затрагивается. `ConversationMode.auto`/`semi_auto` уже корректно используются в TS-коде.
- **Прод-деплой** — `prisma migrate deploy` должен пройти на чистом Postgres все 11 миграций (`0_init` → `9a_chat_modes_backfill_semi_auto`) без ошибок.
- **Dev** — никаких ручных шагов: текущая dev-БД уже имеет правильное состояние схемы и нулевую историю миграций; первый запуск `migrate deploy` накатит всё с нуля (на чистой БД) или потребует `db pull` / `migrate resolve` (если оставлять текущую — операционное решение, вне scope этого hotfix).
- **Тестирование** — `pnpm db:reset` на пустом Postgres должен пройти все 11 миграций без ошибок. Это и есть приёмочный критерий.
- **Риски** — низкие. Идемпотентность backfill (`WHERE = 'auto'`) гарантирует, что миграция 9a не сломает данные, если её прогнать несколько раз.
