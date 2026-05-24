## Context

Параллельный storage AJTBD (`Campaign.ajtbd` + `Campaign.goal`) — техдолг с момента ввода `campaign_type` registry. `goal` валидируется против `CampaignType.goalSchema` (типизированно), `ajtbd` — JSON произвольной формы. Для CustDev обе колонки содержат одну и ту же информацию; для agency_sourcing `ajtbd` хранит синтезированный scaffold, который никто не редактирует.

Полный закрытый цикл миграции:

1. Backfill `goal` из `ajtbd` для строк, где `goal IS NULL`.
2. Все консьюмеры читают `Campaign.goal`, мапят к AJTBD-shape через `extractAjtbdView` для агентов, которые ожидают AJTBD-вход.
3. Drop колонки.

## Goals / Non-Goals

**Goals:**
- Один источник истины для goal/AJTBD: `Campaign.goal`.
- Безопасный путь миграции: backfill сначала, drop потом, в **разных** SQL-миграциях (как в `fix-migration-4-enum-tx`).
- Не менять контракты агентов — переход прозрачен изнутри.

**Non-Goals:**
- Не нормализуем AJTBD в отдельную таблицу — JSON остаётся.
- Не меняем `goalSchema` или AJTBD-форму — только источник.
- Не дропаем `goalText`/`valueProp` (используются как fallback в scaffold).

## Decisions

### Decision 1: `extractAjtbdView(campaign)` — pure helper, агенты не знают о `goal`

**Что:** Воркер вычисляет AJTBD-shape из `campaign.goal` + `campaign.type.key`. Если `type.key === 'custdev'` → пробуем `CampaignAjtbdZ.safeParse(goal)`, при успехе passthrough; в противном случае (другой type или сломанная shape) — scaffold из `goalText`/`valueProp`. Агенты продолжают принимать `ajtbd: CampaignAjtbd` как и сейчас.

**Почему дискриминатор по `typeKey`, а не по форме `goal`:**
- AJTBD-поля имеют Zod defaults — наивный `CampaignAjtbdZ.safeParse(any-object)` тихо схлопнул бы non-AJTBD goal (например, agency `target_data_points`) в empty-defaults AJTBD и потерял бы исходный goalText/valueProp scaffold.
- Shape-detector «есть `forces` key» fragile в обе стороны: будущий builder-authored type может иметь `forces` по совпадению; legacy CustDev-строка с частичным AJTBD может НЕ иметь forces и потерять `job`/`desired_outcome`.
- `type.key` — единственное определённое в системе различение AJTBD vs non-AJTBD goal_schema.

**Почему агенты не получают `goal` напрямую:**
- Минимизирует blast-radius: контракты агентов и их тесты не меняются.
- Concentrate the mapping в одном месте, легко тестировать.
- Если в будущем понадобится AJTBD для agency_sourcing — расширим mapper, не трогая агенты.

### Decision 2: Backfill ПЕРЕД drop, в отдельной миграции

**Что:** Две миграции:
- `9b_backfill_campaign_goal_from_ajtbd/migration.sql`: `UPDATE Campaign SET goal = ajtbd WHERE goal IS NULL AND ajtbd IS NOT NULL`.
- `9c_drop_campaign_ajtbd/migration.sql`: `ALTER TABLE "Campaign" DROP COLUMN "ajtbd"`.

**Почему:**
- Идемпотентность: backfill можно прогонять повторно безопасно.
- Безопасность: до drop'а можно убедиться, что `goal` популирована для всех строк (тестировать на дев).
- Параллельно с fix-migration-4-enum-tx pattern: «backfill» отдельно от структурного изменения.

**Префикс:** `9b_*` и `9c_*` — после `9a_chat_modes_backfill_semi_auto`. Стандартная sequential convention (Prisma сортирует лексикографически, эти сортируются корректно).

### Decision 3: API убирает `ajtbd` сразу, без deprecation

**Что:** `CampaignZ` / `CreateCampaignInputZ` / `UpdateCampaignInputZ` больше не имеют поля `ajtbd`. Эти схемы не `.strict()`, так что `ajtbd` в теле запроса будет тихо отброшен Zod'ом (а не отклонён 400-ой); важно, что он точно не запишется в БД — колонки больше нет.

**Почему:**
- Внутренний web мигрирован в этом же change'е — единственный «клиент» API на сегодня.
- Внешних клиентов нет (нет publicly документированного API).
- Deprecation period усложняет: пришлось бы поддерживать оба варианта в сервисе, что и есть текущий dual-write tech-debt.

**Альтернатива:** Принимать `ajtbd` как input, мапить в `goal` server-side, не возвращать. Отвергнуто — добавляет код и аппарат удаления потом.

## Risks / Trade-offs

- **[Риск средний] Регрессия в один из 5+ консьюмеров.** Митигация: целевые unit-тесты на `extractAjtbdView`; обновляем все ajtbd-зависимые тесты и проверяем `pnpm test` после каждого шага.
- **[Риск] Schema-prisma vs Zod несоответствие на момент мержа.** Если БД-миграция ещё не накатана, а код уже ждёт отсутствия колонки — Prisma client'у пофигу (она клиентская, не валидирует server-side schema). Миграции применяются всегда раньше старта app'а в проде.
- **[Trade-off] Web-bookmarks на старые request-shape'ы могут сломаться.** Принимаем — внутренний инструмент, оператор перелогинится.
- **[Trade-off] Audit-log row про `ajtbd` остаются** — это историческая правда, не трогаем.

## Migration Plan

1. Добавить `extractAjtbdView` + unit-тесты.
2. Мигрировать `agent-run.ts` (`ajtbdForCampaign` теперь через `goal`).
3. Мигрировать `api/services/campaigns.ts` (`create`/`update` без `ajtbd`).
4. Удалить `ajtbd` из `CampaignZ`/`Create*Z`/`Update*Z`.
5. Мигрировать `CampaignForm.vue` (убрать чтение `c.ajtbd`).
6. Обновить тесты (mock'и, fixture'ы).
7. Добавить backfill миграцию (9b).
8. Добавить drop миграцию (9c).
9. Удалить колонку из `schema.prisma`.
10. Прогнать smoke на чистой БД (`prisma migrate deploy`).
11. Полная регрессия (`pnpm typecheck && pnpm lint && pnpm test`).
12. Codex review.
13. Архив + коммит.

**Rollback:** до точки 7 — git revert. После 7–10 — incident-mode восстановление колонки + popullate из `goal` (вне scope).

## Open Questions

- `audit_log` имеет ли поле, ссылающееся на `ajtbd` (отдельные строки про создание/обновление AJTBD)? — Проверить в реализации. Если есть `event = 'ajtbd.updated'`, оставить historical, не удалять.
- `apps/api/src/services/campaign-type-builder.ts` — пишет `ajtbd` для drafted-кампаний? Проверить + убрать.
