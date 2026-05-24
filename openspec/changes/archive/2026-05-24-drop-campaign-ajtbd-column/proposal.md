## Why

`Campaign` has двойной storage для AJTBD-структуры: legacy колонка `ajtbd Json?` (с миграции `4_chat_autonomous_modes`) и новая `goal Json?` (с миграции `7_campaign_type_required`, валидируется против `CampaignType.goalSchema`). По дизайн-решению agency-sourcing-matching изначально планировалось drop'нуть `ajtbd` в следующем релизе после backfill verification и миграции консьюмеров.

Сейчас:
- `Campaign.goal` уже популируется для всех новых кампаний (`apps/api/src/services/campaigns.ts#resolveTypeAndGoal`) — для CustDev копирует AJTBD-форму, для agency_sourcing хранит agency-specific shape.
- Но **runtime консьюмеры всё ещё читают `Campaign.ajtbd`**, не `goal`: `HandoffDecider`, `ReplyComposer`, `GoalFitEvaluator`, `agent-run.ts` (`safetyExtras`/`ajtbdForCampaign`), `CampaignForm.vue`. То есть колонка не «оставлена для rollback», а реально используется.
- Параллельный storage привлекает дрейф: write paths могут забыть обновить одну из двух колонок, ajtbd-shape специфичен только для CustDev и неестественно «шиньется» на agency_sourcing.

Drop колонки без миграции консьюмеров сломал бы продакшен. Этот change — полный закрытый цикл: миграция консьюмеров на `goal`, backfill `goal ← ajtbd` для legacy-строк, миграция БД для drop колонки, чистка API/UI/типов.

## What Changes

- **AJTBD-вью из goal**: добавить чистый helper `extractAjtbdView(campaign): CampaignAjtbd` в `packages/shared/src/schemas/ajtbd.ts`. Дискриминатор — `typeKey` кампании: для `custdev` (единственного type, чей `goal_schema` IS AJTBD) пробуем `CampaignAjtbdZ.safeParse(goal)` и passthrough при успехе; для любого другого `typeKey` (agency_sourcing, builder-authored, или null/неизвестный) — всегда scaffold через `buildAjtbdScaffold(goalText, valueProp)`. Не используем shape-based детектор «есть `forces`», потому что он fragile в обе стороны: AJTBD-поля имеют Zod defaults (any-object collapse'нется в empty-AJTBD), а legacy CustDev-строка без `forces` потеряет `job`/`desired_outcome`.
- **Агенты**: переименовать input-поле `ajtbd` в `HandoffDecider`/`ReplyComposer`/`GoalFitEvaluator` оставить тем же (`ajtbd: CampaignAjtbd`), но callsite'ы в воркере вычисляют его через `extractAjtbdView(...)` из `goal`, не читая `campaign.ajtbd` из БД. То есть агенты не меняются — меняются worker'овские мапперы.
- **Worker `agent-run.ts`**: `ajtbdForCampaign(campaign)` теперь читает `campaign.goal` (не `campaign.ajtbd`), и для не-AJTBD-формы возвращает scaffold. Select из Prisma убирает `ajtbd: true`, оставляет `goal: true` + `goalText`/`valueProp` (для scaffold-fallback).
- **API `campaigns.ts`**: `create`/`update` больше не принимают/пишут `ajtbd`. `CreateCampaignInputZ` / `UpdateCampaignInputZ` отрываются от `CampaignAjtbdZ`-поля. Сервис всегда работает через `goal` + `resolveTypeAndGoal`.
- **API `CampaignZ`**: убираем `ajtbd: CampaignAjtbdZ.nullable()` (поле читается как часть `goal`).
- **Web `CampaignForm.vue`**: AJTBD-редактор (legacy для CustDev) уже заменён typed-goal editor'ом (из CHANGELOG: «тип-specific goal editor»). Удаляем оставшийся код, читающий/пишущий `c.ajtbd`.
- **Backfill migration**: `UPDATE "Campaign" SET goal = ajtbd WHERE goal IS NULL AND ajtbd IS NOT NULL` (идемпотентно). Делается в отдельной миграции ПЕРЕД drop column.
- **Drop migration**: `ALTER TABLE "Campaign" DROP COLUMN "ajtbd"` после backfill'а. Префикс под текущую convention (`9b_*` или `9c_*` — после `9a_chat_modes_backfill_semi_auto`).
- **Тесты**: обновить мокажи и фикстуры, которые ставят `ajtbd` на campaign'ы; добавить тест на `extractAjtbdView` (CustDev goal → identity; agency_sourcing goal → scaffold).
- **CHANGELOG**: `### Removed` запись.

## Capabilities

### New Capabilities
Нет.

### Modified Capabilities
- `campaign-ajtbd-framing`: дельта-спека убирает упоминание `Campaign.ajtbd` как storage; источник истины — `Campaign.goal` + helper `extractAjtbdView`.
- `campaign-type-registry`: дельта-спека уточняет, что для legacy CustDev-кампаний `goal` хранит AJTBD-форму, и удаляет упоминания дублирования с `Campaign.ajtbd`.

## Impact

- **Файлы**:
  - `packages/db/prisma/schema.prisma` — удаление колонки `ajtbd`.
  - `packages/db/prisma/migrations/9b_backfill_campaign_goal_from_ajtbd/migration.sql` — новая (backfill).
  - `packages/db/prisma/migrations/9c_drop_campaign_ajtbd/migration.sql` — новая (drop).
  - `packages/shared/src/schemas/campaign.ts` — убираем `ajtbd` из `CampaignZ`, `CreateCampaignInputZ`, `UpdateCampaignInputZ`.
  - `packages/shared/src/schemas/ajtbd.ts` (или `campaign-type-resolve.ts`) — новый `extractAjtbdView`.
  - `packages/agents/src/agents/HandoffDecider.ts`, `ReplyComposer.ts`, `GoalFitEvaluator.ts` — без изменений (input-shape остаётся).
  - `apps/workers/src/queues/agent-run.ts` — `ajtbdForCampaign` теперь через goal; убираем `ajtbd: true` из select.
  - `apps/api/src/services/campaigns.ts` — `create`/`update` без записи `ajtbd`.
  - `apps/api/src/services/campaign-type-builder.ts` — если пишет `ajtbd`, удалить.
  - `apps/web/src/features/campaigns/CampaignForm.vue` — выпил остаточного `c.ajtbd`.
  - `apps/web/src/features/campaigns/types.ts` (если есть) — без `ajtbd`.
  - `packages/db/prisma/seed.ts` — если ставит `ajtbd` в сиде, убрать.
  - `CHANGELOG.md` — `### Removed`.
  - `openspec/specs/campaign-ajtbd-framing/spec.md` — дельта.
  - `openspec/specs/campaign-type-registry/spec.md` — дельта (если затронуто).
- **Поведение**: с точки зрения runtime'а — ничего не меняется (агенты получают тот же AJTBD-shape). С точки зрения API — request/response больше не имеют `ajtbd` (BREAKING для внешних клиентов, если есть; внутренний web мигрирован в этом же change'е).
- **Прод-деплой**: после мержа `prisma migrate deploy` сначала backfill (9b), потом drop (9c). Никаких ручных шагов.
- **Откат**: невозможен без data loss после drop (9c). Митигация: backfill (9b) гарантирует, что вся информация уже есть в `goal`; rollback миграции 9c можно реализовать как `ALTER TABLE ADD COLUMN ajtbd Json` + repopulate из goal, но это incident-only.
- **Тестирование**: smoke прогон `prisma migrate deploy` на чистой БД (как в `fix-migration-4-enum-tx`); полная регрессия (`pnpm typecheck && pnpm lint && pnpm test`); ручной чек: создать CustDev-кампанию через API, убедиться что агенты получают AJTBD-shape правильный.
- **Риски**: средние. Большая регрессионная поверхность (5+ агентов, web UI, миграции). Митигация: пошагово, Codex review, конкретные unit-тесты `extractAjtbdView`, regression на ajtbd-зависимых юнит-тестах.
