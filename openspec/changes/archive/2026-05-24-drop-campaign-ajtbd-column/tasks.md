## 1. Helper и тесты

- [x] 1.1 В `packages/shared/src/schemas/ajtbd.ts` добавить `extractAjtbdView(campaign: { goal: unknown, goalText: string, valueProp: string }): CampaignAjtbd` — если goal проходит `CampaignAjtbdZ.safeParse` → возвращает его data; иначе возвращает `buildAjtbdScaffold({ goalText, valueProp })`.
- [x] 1.2 Unit-тест в `packages/shared/src/__tests__/extractAjtbdView.test.ts` (или ближайший существующий location): CustDev goal с AJTBD-shape → identity; agency_sourcing goal с `target_data_points` → scaffold из goalText/valueProp; null goal → scaffold.

## 2. Worker миграция

- [x] 2.1 В `apps/workers/src/queues/agent-run.ts`: переписать `ajtbdForCampaign(campaign)` чтобы читать `campaign.goal` (не `campaign.ajtbd`) через `extractAjtbdView`. Select из Prisma: убрать `ajtbd: true`, оставить `goal: true`, `goalText: true`, `valueProp: true` (типы кампании уже подгружены).
- [x] 2.2 Проверить, что все три callsite'а в `agent-run.ts`, где используется `ajtbdForCampaign(...)` / `campaign.ajtbd`, корректно переходят.

## 3. API сервис

- [x] 3.1 В `apps/api/src/services/campaigns.ts#create`: убрать чтение/запись `ajtbd`; через `resolveTypeAndGoal` всё ещё работает (он принимает `ajtbd` как fallback — это можно убрать или оставить как «legacy input scaffolding», но НЕ писать в БД).
- [x] 3.2 В `apps/api/src/services/campaigns.ts#update`: убрать ветку `patch.ajtbd`.
- [x] 3.3 В `apps/api/src/services/campaigns.ts#resolveTypeAndGoal`: оставить fallback на `ajtbd` как input (для обратной совместимости с тестами и web), но переименовать-комментировать, что это transitional.
- [x] 3.4 `apps/api/src/services/campaign-type-builder.ts:117` — если пишет `ajtbd` в drafted campaign, заменить на `goal`.

## 4. Shared schemas

- [x] 4.1 В `packages/shared/src/schemas/campaign.ts`: удалить `ajtbd: CampaignAjtbdZ.nullable()` из `CampaignZ`. Удалить `ajtbd: CampaignAjtbdZ.optional()` из `CreateCampaignInputZ` / `UpdateCampaignInputZ` (если присутствует в `UpdateCampaignInputZ`).
- [x] 4.2 Проверить, что нет других мест в `@nosquare/shared` со ссылкой на `Campaign.ajtbd` (grep).

## 5. Web

- [x] 5.1 В `apps/web/src/features/campaigns/CampaignForm.vue`: убрать чтение/запись `c.ajtbd`. Если AJTBD-секция формы ещё опирается на это поле — переписать чтобы читать из `c.goal` (для CustDev shape).
- [x] 5.2 Проверить остальные web-файлы (`apps/web/src/**/*.vue|*.ts`) на `ajtbd`-ссылки.

## 6. Тесты

- [x] 6.1 Обновить все unit-тесты, где fixture'ы кампаний ставят `ajtbd: ...`. Заменить на `goal: ...` или убрать.
- [x] 6.2 Регрессия: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## 7. Backfill миграция

- [x] 7.1 Создать `packages/db/prisma/migrations/9b_backfill_campaign_goal_from_ajtbd/migration.sql`: `UPDATE "Campaign" SET goal = ajtbd WHERE goal IS NULL AND ajtbd IS NOT NULL` + idempotency-комментарий.

## 8. Drop column миграция и schema

- [x] 8.1 Создать `packages/db/prisma/migrations/9c_drop_campaign_ajtbd/migration.sql`: `ALTER TABLE "Campaign" DROP COLUMN "ajtbd"`.
- [x] 8.2 Удалить колонку `ajtbd` из `packages/db/prisma/schema.prisma`.
- [x] 8.3 Удалить ajtbd-backfill блок из миграции 4 (`packages/db/prisma/migrations/4_chat_autonomous_modes/migration.sql`)? Нет — миграция 4 уже исторически применена в части окружений, не меняем; колонка просто перестанет существовать после 9c.

## 9. Smoke на чистой БД

- [x] 9.1 Поднять временный Postgres-контейнер, прогнать `prisma migrate deploy` → 13 миграций без ошибок.
- [x] 9.2 Проверить через psql: колонка `ajtbd` отсутствует на `Campaign`; `goal` присутствует.
- [x] 9.3 `pnpm db:seed` отрабатывает без ошибок.
- [x] 9.4 Снести контейнер.

## 10. Документация

- [x] 10.1 `CHANGELOG.md` → `## Unreleased → ### Removed`: запись про удаление колонки.
- [x] 10.2 Если `CLAUDE.md`/`DESIGN.md` упоминают `Campaign.ajtbd`, обновить (хотя в проекте нет; проверить).

## 11. Ревью и архив

- [x] 11.1 Codex review (синхронно через `codex-companion.mjs task`).
- [x] 11.2 Применить замечания.
- [x] 11.3 `openspec archive drop-campaign-ajtbd-column --yes`.
- [x] 11.4 Закоммитить: `refactor(campaign): migrate ajtbd consumers to Campaign.goal + drop legacy column`.
