# RUNBOOK — fix-migration-4-enum-tx

Краткая инструкция для команды и ops после мержа hotfix-change `fix-migration-4-enum-tx`.

## Что поменялось

1. `packages/db/prisma/migrations/4_chat_autonomous_modes/migration.sql`
   — из файла удалены два `UPDATE`-стейтмента, которые мигрировали
   legacy-строки `mode='auto'` → `mode='semi_auto'`. Файл всё ещё
   добавляет enum-значение `semi_auto`, колонки `Campaign.ajtbd`,
   `Conversation.qualityDecision`, `Conversation.lastSyncedAt` и
   делает backfill JSON `ajtbd`.
2. Новый файл
   `packages/db/prisma/migrations/9a_chat_modes_backfill_semi_auto/migration.sql`
   — содержит тот самый backfill, но в **отдельной транзакции**, что
   позволяет Postgres увидеть только что добавленное enum-значение
   `semi_auto`.

## Кого это затрагивает

### Прод / staging — свежий кластер (нет `_prisma_migrations`)

`prisma migrate deploy` на чистой БД теперь проходит без ошибок. Это и
была основная цель — снять release-blocker. Никаких действий не
требуется, кроме обычного деплоя.

### Прод / staging — кластер, где старая миграция 4 уже падала

Это самый рисковый сценарий. Если до мержа этого hotfix кто-то уже
пытался выкатить старую версию миграции 4, в БД останется **failed**
строка в `_prisma_migrations` (`finished_at IS NULL`,
`rolled_back_at IS NULL`), и `prisma migrate deploy` после мержа
откажется продолжать с сообщением вида
«migration `4_chat_autonomous_modes` failed».

Сначала определи состояние:

```bash
psql "$DATABASE_URL" -c "SELECT migration_name, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations WHERE migration_name = '4_chat_autonomous_modes';"
```

Возможные исходы:

- **Failed (recommended path: пометить как rolled-back и переприменить).**
  Если строка существует и `finished_at IS NULL`, отметь её как
  откаченную и снова запусти deploy — новая (исправленная) миграция 4
  применится впервые, затем сразу 9a:

  ```bash
  cd packages/db
  pnpm exec prisma migrate resolve --rolled-back "4_chat_autonomous_modes"
  pnpm exec prisma migrate deploy
  ```

  В исправленной миграции 4 используется только идемпотентный
  `ALTER TYPE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` /
  ajtbd-backfill с `WHERE "ajtbd" IS NULL`, поэтому повторное
  применение безопасно, даже если часть колонок уже существует от
  failed-попытки.

- **Disposable окружение (recommended path: пересоздать).** Если
  staging-БД можно сбросить, это самый дешёвый путь:

  ```bash
  pnpm db:reset       # drop + migrate + seed (только для одноразовых окружений!)
  ```

  Никогда не делай этого на проде с реальными данными.

### Разработчики на ноутбуках — нет `_prisma_migrations`

Если у тебя в локальной БД **нет** таблицы `_prisma_migrations`
(например, схема была накатана через `prisma db push`, что в этом
репо поведение по умолчанию `pnpm dev`), всё уже консистентно —
действий не требуется.

### Разработчики на ноутбуках — миграция 4 уже **applied**

Если ты у себя локально гонял миграции через `prisma migrate dev`/
`migrate deploy` ДО этого hotfix и в `_prisma_migrations` есть
запись с `finished_at IS NOT NULL AND rolled_back_at IS NULL` для
`4_chat_autonomous_modes`, у тебя два варианта:

**Вариант A — пересоздать БД.** Самый быстрый и безусловно
безопасный путь, если локальные данные не важны:

```bash
pnpm db:reset
```

**Вариант B — оставить applied-строку миграции 4 как есть, применить
только 9a поверх.** Подходит, если хочется сохранить локальные
данные. Prisma не запускает уже-applied миграции повторно, даже
если их содержимое изменилось; она лишь выведет warning о drift
(`migration X has been edited after it was applied`). Все эффекты
старой версии миграции 4 (новое enum-значение `semi_auto`, колонки
`ajtbd`/`qualityDecision`/`lastSyncedAt`, ajtbd-backfill, legacy
`auto`→`semi_auto` UPDATE) уже выполнены при её первоначальном
прогоне, поэтому повторное применение и не требуется. Достаточно
накатить только новое 9a:

```bash
cd packages/db
pnpm exec prisma migrate deploy
```

NB: не используй `prisma migrate resolve --rolled-back
"4_chat_autonomous_modes"` для applied-строки — Prisma ответит
«migration is not in a failed state». Этот ключ работает только
для **failed** миграций (см. секцию выше про прод/staging).

Если ловил локально runtime-ошибки и есть подозрение, что состояние
БД отошло от номинального — предпочти Вариант A (`db:reset`).

## CI

Тесты не зависят от истории миграций (используется временный Postgres
из `compose.dev.yml`, который пересоздаётся). Никаких действий не
требуется.

## Регрессионная проверка

После применения убедиться, что:

- **Все четыре enum-значения присутствуют** (порядок может отличаться
  — `ADD VALUE` добавляет `semi_auto` после остальных, поэтому
  сравниваем как множества; `::text` нужен, иначе `enum[]` ≠ `text[]`
  по типу):

  ```sql
  SELECT array(SELECT unnest(enum_range(NULL::"ConversationMode"))::text ORDER BY 1)
       = ARRAY['assisted','auto','manual','semi_auto']::text[] AS ok;
  ```

  Ожидание: `ok = t`.

- **`_prisma_migrations` содержит все миграции в состоянии `applied`**:

  ```sql
  SELECT count(*) FROM _prisma_migrations
   WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  -- 11 на момент мержа этого change.
  ```

- **Нет legacy `auto`-строк**:

  ```sql
  SELECT count(*) FROM "Conversation" WHERE "mode" = 'auto';
  SELECT count(*) FROM "Campaign"     WHERE "defaultMode" = 'auto';
  -- оба = 0
  ```
