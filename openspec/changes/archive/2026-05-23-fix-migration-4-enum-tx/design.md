## Context

Файл `packages/db/prisma/migrations/4_chat_autonomous_modes/migration.sql` собирает в одну транзакцию три блока работы:

1. `ALTER TYPE "ConversationMode" ADD VALUE IF NOT EXISTS 'semi_auto'`
2. Добавление колонок (`Campaign.ajtbd`, `Conversation.qualityDecision`, `Conversation.lastSyncedAt`) и backfill JSON `ajtbd` из `goalText`/`valueProp`.
3. `UPDATE "Conversation" SET "mode" = 'semi_auto' WHERE "mode" = 'auto'` и аналогично для `Campaign.defaultMode`.

Postgres исполняет содержимое одного SQL-файла Prisma как одну транзакцию. Документация Postgres явно запрещает использовать значение, добавленное `ALTER TYPE ADD VALUE`, в той же транзакции (`new enum value cannot be referred to until it has been committed`). Поэтому шаг 3 падает на любом свежем кластере.

В dev среде схема была развернута через `prisma db push`, а не `migrate deploy`. Поэтому таблица `_prisma_migrations` отсутствует, нечего «дофиксировать» через `migrate resolve`. Прод никогда не катился. Это даёт максимум свободы — мы можем безопасно переписать содержимое уже существующего файла миграции 4.

Затронутые системы: только пакет `@nosquare/db` (Prisma schema + миграции). TS-код, использующий `ConversationMode.semi_auto`, уже корректен и менять его не нужно.

## Goals / Non-Goals

**Goals:**
- `pnpm db:migrate:deploy` отрабатывает все 11 миграций (`0_init` → `9a_chat_modes_backfill_semi_auto`) на пустом Postgres без ошибок.
- Идемпотентность: повторный прогон миграции 9a не ломает данные.
- Никаких функциональных изменений в TS-коде или агентских конфигах.
- RUNBOOK для ops описывает один человеческий способ привести dev-БД к консистентному состоянию (опционально, чтобы команда могла свободно использовать `db:reset`).

**Non-Goals:**
- Не вводим общую capability/механизм для enum-миграций — это hotfix, не процессное изменение. Если в будущем потребуется тот же паттерн (ADD VALUE + backfill), команда вспомнит этот change как пример.
- Не трогаем `auto` → `semi_auto` семантику в TS — она уже корректна.
- Не удаляем legacy enum-значение `auto`: оно ещё используется в API-нормализации (см. archived change `chat-autonomous-modes`, Decision 1). Удаление — отдельный future-change.
- Не вводим backfill для `ajtbd` (он и так уже идёт в миграции 4 — оставляем как есть).

## Decisions

### Decision 1: Расщепить в Migration 4 + новая Migration 9a, а не Migration 4a/4b или переименовывать

**Что:** Migration 4 оставляет имя `4_chat_autonomous_modes`, но из её SQL удаляются `UPDATE`-инструкции, использующие `semi_auto`. Backfill переезжает в новую миграцию `9a_chat_modes_backfill_semi_auto/migration.sql`.

**Почему:**
- Sequential numeric prefix — текущая convention репо (`0_init` → `9_channel_discovery_flag`). Префиксы `4a_*`/`4b_*` сортируются между `4_*` и `5_*` лексикографически, но ломают convention и читаемость `git log`.
- Переименование `4_chat_autonomous_modes` → `4a_*` рискованно: на любой среде, где prisma всё-таки её записал в `_prisma_migrations` (например, у разработчиков на ноутбуках), checksum/имя расходятся и `migrate deploy` ругается. Дешевле сохранить имя.
- Раздельные миграционные файлы Prisma запускает в РАЗНЫХ транзакциях. Это и есть наш фикс: COMMIT после миграции 4 делает `semi_auto` видимым; миграция 9a работает в новой транзакции и спокойно его использует.

**Почему префикс `9a_*`, а не `10_*`:**
Prisma упорядочивает миграции лексикографически по имени директории. Из-за ASCII (`0`=0x30 < `_`=0x5F < `a`=0x61) `10_*` сортируется не как «после девятки», а **между** `0_*` и `1_*`: smoke на чистом Postgres подтвердил это — `10_*` запустился вторым (после `0_init`) и упал с `invalid input value for enum "ConversationMode": "semi_auto"`, потому что миграция 4 ещё не успела добавить enum-значение. Префикс `9a_*` гарантированно сортируется после `9_*` (поскольку `_` < `a`), оставаясь в существующей нумерационной схеме.

**Альтернативы рассмотрены:**
- *Migration 4 без правок + новая Migration 9a backfill*. Не работает: на свежей БД миграция 4 всё ещё валится до того, как мы дойдём до 9a.
- *Inline в Migration 4 через `COMMIT;` посередине файла*. Prisma переписывает/обнаруживает такие конструкции — недокументированное поведение, рискованно для апгрейдов Prisma.
- *Расщепить через `4a_*`/`4b_*`*. Отвергнуто — см. выше.

### Decision 2: Backfill идемпотентный и условный

**Что:** Миграция 9a содержит только два `UPDATE` с `WHERE = 'auto'`. Никаких `ALTER`, никаких побочных эффектов.

**Почему:**
- На свежей prod-БД нет строк со значением `auto` — миграция отработает с `0 rows updated`.
- На dev/любых средах, где legacy-данные есть, миграция корректно их подхватит.
- Повторный прогон (если вдруг `migrate resolve` отметит её как `rolled_back` и переприменит) безопасен.

### Decision 3: Не трогать ajtbd-backfill из миграции 4

**Что:** `UPDATE "Campaign" SET "ajtbd" = jsonb_build_object(...)` в миграции 4 остаётся.

**Почему:** Этот UPDATE не использует enum-значение `semi_auto`, он работает с JSON и текстовыми колонками. Перенос в отдельную миграцию ничего не выигрывает и создал бы шум.

### Decision 4: RUNBOOK для dev-команды — опциональный

**Что:** Кратко документируем в `openspec/changes/fix-migration-4-enum-tx/RUNBOOK.md`, что после мержа разработчику нужно либо `pnpm db:reset` (если данные не важны), либо игнорировать (если работает с `db push`).

**Почему:** Большинство dev-окружений используют `db push` и не имеют `_prisma_migrations`. Активная инструкция нужна только тем, кто баловался с `migrate dev` локально. Прод — отдельная история и требует обычного `migrate deploy` на пустую БД.

## Risks / Trade-offs

- **[Риск] Разработчик с локальной `_prisma_migrations`, где `4_chat_autonomous_modes` помечена как failed** (`finished_at IS NULL`): `prisma migrate deploy` откажется продолжать до явного разрешения failed-строки.
  → **Митигация:** RUNBOOK предлагает `prisma migrate resolve --rolled-back "4_chat_autonomous_modes"` + `prisma migrate deploy` (накатит новую версию миграции 4, затем 9a). Альтернатива: `pnpm db:reset`. Это локальная боль одного-двух людей, не блокер для прод-релиза.
- **[Риск] Разработчик с локальной `_prisma_migrations`, где `4_chat_autonomous_modes` помечена как applied** (`finished_at IS NOT NULL`): после `git pull` Prisma эмитит drift-warning «migration has been edited after it was applied», но deploy продолжается и накатывает только новое 9a.
  → **Митигация:** RUNBOOK явно говорит игнорировать warning (или сделать `db:reset` ради чистоты истории). НЕ использовать `migrate resolve --rolled-back` для applied — Prisma его отклонит как «not in a failed state».
- **[Риск] Кто-то добавит в миграцию 4 новый код, использующий `semi_auto`, не глянув в RUNBOOK.**
  → **Митигация:** В файле миграции 4 в начале добавляем длинный комментарий «DO NOT USE 'semi_auto' IN THIS FILE — see migration 9a_chat_modes_backfill_semi_auto».
- **[Риск] Если в будущем понадобится добавить ещё одно значение в `ConversationMode` (например, `paused`), тот же баг повторится.**
  → **Митигация:** Не вводим формальную capability «database-migrations» (overkill), но комментарий в миграции 4 + AGENTS.md note создают прецедент-памятку.
- **[Trade-off] Миграция 9a пуста на свежей БД** (только `WHERE = 'auto'`). Это нормально — стоимость пустого UPDATE на пустом Conversation/Campaign пренебрежима, а семантика остаётся одной для всех окружений.
- **[Trade-off] Префикс `9a_*` — техдолг.** Это разовый workaround под лексикографическую сортировку Prisma. Если в будущем понадобится добавить миграцию, логически принадлежащую между `4_*` и `5_*`, или просто следующую за `9a_*`, ситуация снова становится неудобной. Чистое долгосрочное решение — переименовать все миграции в zero-padded форме (`00_init`, `01_*`, … `09_*`, `09a_*` или `10_*`). Это отдельный change (не в этом hotfix, чтобы не раздувать blast-radius), но стоит поднять как follow-up до следующей миграции.

## Migration Plan

1. Поправить `migration.sql` миграции 4 (удалить строки 53–54).
2. Создать `packages/db/prisma/migrations/9a_chat_modes_backfill_semi_auto/migration.sql`.
3. Прогнать на чистой БД (отдельный временный docker-контейнер): `prisma migrate deploy` → проверить, что все 11 миграций (`0_init` → `9a_chat_modes_backfill_semi_auto`) применяются.
4. Прогнать `pnpm typecheck && pnpm test`.
5. Обновить `CHANGELOG.md` (Fixed) + дельта-спека `chat-autonomy-modes`.
6. Запросить ревью через `codex:rescue`.
7. После аппрува — мерж + `openspec archive`.

**Rollback:**
- Откат миграции 9a — `UPDATE Conversation SET mode='auto' WHERE mode='semi_auto'` (но семантика поменяется; делать только в incident-response).
- Откат правок миграции 4 — `git revert` коммита. Если миграция 4 уже была применена в её новой версии на каком-то окружении и нужно вернуть данные, придётся вручную восстанавливать `mode='auto'` строки (но мы их в первую очередь не меняли в новой версии).

## Open Questions

- ~~Можно ли менять содержимое уже применённой миграции 4?~~ — Снято. `_prisma_migrations` в dev отсутствует, прод не катился. Меняем спокойно.
- ~~Какой префикс для новой миграции — `4a_`, `10_` или что-то ещё?~~ — Снято. Шли `10_` ради sequential convention, поймали лексикографическую сортировку Prisma (`10_*` уходит между `0_*` и `1_*`), переименовали в `9a_*` (`_` < `a`, поэтому сортируется после `9_*`). Долгосрочно — zero-padding всех префиксов, отдельный change.
