# CLAUDE.md

Навигация по проекту для Claude Code. Прочти этот файл перед любой задачей.

## TL;DR
Backend на Node.js + TypeScript (монорепо, pnpm workspaces) с React-админкой. Скрейпит каналы (TG / IG / YT), вытаскивает контакты для рекламы из описаний, шлёт CustDev-приглашения через Telegram (GramJS), ведёт диалог с подсказками от ИИ-агентов. Цель — НЕ продажа, а интервью по продукту. Это важно — пронизывает промпты и safety-правила.

Use case и стек — в `README.md`. Архитектура и схема БД — в `DESIGN.md`. Агенты, контракты и пайплайны — в `AGENTS.md`. Если задача затрагивает архитектуру — сначала туда.

## Команды

```bash
pnpm install
pnpm dev                # turbo run dev — api + web + workers параллельно
pnpm dev:api / dev:web / dev:workers
pnpm build / typecheck / lint / format
pnpm test                       # vitest по всем пакетам
pnpm test --filter agents       # один пакет
pnpm test:e2e                   # playwright, требует docker compose up

pnpm db:migrate                 # prisma migrate dev
pnpm db:migrate:deploy          # для CI/prod
pnpm db:seed
pnpm db:studio
pnpm db:reset                   # drop + migrate + seed (только dev!)
```

## Где что лежит

| Хочу… | Иду в… |
|---|---|
| Добавить REST-роут | `apps/api/src/routes/` + zod-схема в `packages/shared/src/schemas/` |
| Добавить WS-событие | `apps/api/src/realtime/` + типы в `packages/shared/src/realtime.ts` |
| Новая страница/виджет | `apps/web/src/features/<feature>/` |
| Новый агент | `packages/agents/src/agents/<Name>.ts` + регистрация в `registry.ts` + сид в `packages/db/prisma/seed.ts` |
| Новый LLM-провайдер | `packages/llm/src/providers/<name>.ts` имплементит `LLMProvider` + `factory.ts` |
| Новая платформа (TikTok, X) | `packages/platforms/src/<name>/Adapter.ts` имплементит `PlatformAdapter` + регистрация |
| Новый ScrapeCreators-метод | `packages/platforms/src/scrapecreators/Client.ts` |
| Новый TG-метод | `packages/tg-client/src/methods/` — типизированный DTO, не сырые `Api.*` |
| Поменять схему БД | `packages/db/prisma/schema.prisma` → `pnpm db:migrate` |
| Новая фоновая задача | `apps/workers/src/queues/` |

## Конвенции кода

- **TS strict**: `strict: true`, `noUncheckedIndexedAccess: true`. `any` — только с TODO + issue.
- **Валидация на границах**: всё, что приходит снаружи (HTTP, WS, очереди, LLM, ScrapeCreators-ответы) — через `zod`.
- **Сервисный слой**: роуты не дёргают Prisma/GramJS/LLM/ScrapeCreators напрямую. Зовут сервисы или ставят задачи в очередь.
- **Ошибки**: `AppError(code, message, statusCode, details?)` из `packages/shared/src/errors`. Никаких `throw "string"`. Маппинг на HTTP — в одном месте.
- **Логи**: `pino` с обязательными полями `{ channelId?, contactId?, conversationId?, agent?, requestId }`. В проде нет текстов сообщений (`LOG_MESSAGE_BODIES=false`).
- **Время**: всегда UTC в БД и API. Локальный TZ — только в UI.
- **Деньги/токены**: каждый LLM-вызов пишет `agent_run` (tokens_in/out, cost_usd). Никаких неучтённых вызовов.
- **Git**: ветки `feat/...`, `fix/...`, `refactor/...`. Конвенциональные коммиты. Никаких прямых пушей в `main`.

## Чего не делать

1. **Не дёргать GramJS из API-роутов.** Только через очередь `tg-send` или сервис. Иначе — гонки за сессией и FloodWait.
2. **Не ходить в ScrapeCreators напрямую из роутов.** Через сервис `platforms`, очередь `channel-scrape`, с учётом квоты ключа.
3. **Не отправлять сообщение, не записав его в `message`** заранее (status=`pending`). Иначе при падении воркера потеряем состояние.
4. **Не хранить TG-сессии в файлах в проде.** Только зашифрованной строкой в `tg_account.session_encrypted`.
5. **Не вызывать LLM напрямую в обработчиках.** Только через `AgentRunner` — он подгружает конфиг из БД, выбирает endpoint, считает токены, пишет `agent_run`.
6. **Не править промпты хардкодом.** Промпты — в `agent_config`. Хардкод — только как fallback, если в БД пусто.
7. **Не уводить диалог за рамки заявленного типа кампании.** Поведение, framing и safety теперь задаёт `campaign_type` (реестр, см. `DESIGN.md`/`AGENTS.md`). Для типа `custdev` — никаких «давайте созвонимся обсудить ваш канал», «у нас есть для вас оффер», обещаний результата, упоминания «реклама» (цель — интервью). Для `agency_sourcing` коммерческая лексика (реклама/прайс/охваты) — наоборот, on-goal; запрещены гарантии результата, выдуманные детали клиента, перевод денег/ссылки до подтверждения оператором, давление. Запреты/разрешения берутся из `campaign_type.safetyProfile`, а не хардкодом; `SafetyFilter` получает `forbidden_topics`/`allowed_topics` из профиля типа. Не хардкодь framing — он в реестре.
8. **Не ронять оператору диалог.** Любая ошибка в пайплайне → диалог в `assisted` с пометкой и причиной. Тишина в чате — худший исход.
9. **Не логировать `api_key`, `session_encrypted`, тексты исходящих** в DEBUG/INFO даже в dev. Используй `redact()`.

## Тесты

- **Unit** (`vitest`): чистая логика — агенты с замоканным `LLMProvider`, парсеры, регулярки `ContactExtractor`, утилиты. Цель ≥ 70% веток в `packages/agents` и `packages/platforms`.
- **Интеграционные**: реальный Postgres + Redis из `compose.dev.yml`, моки LLM/GramJS/ScrapeCreators. В `apps/*/tests/integration`.
- **E2E** (`playwright`): сценарии админки.
- **TG-клиент**: моки в `packages/tg-client/__mocks__/MTProto.ts`. Не делать настоящих TG-логинов в CI.
- **ScrapeCreators**: записанные фикстуры (`msw`) для каждого endpoint. Не палить квоту в CI.
- **LLM**: фикстуры через `msw`. Не звонить в Yandex/OpenRouter из тестов.

## Фичефлаги и env

- **Рантайм-флаги (rollout/kill-switch)** — в БД (`feature_flag`), переключаются из админки (Settings → Features, только admin), кэшируются в процессе и инвалидируются по Redis pub/sub (`runtime-feature-flags`). Читать через `getFeatureFlags().get('<key>')` (синхронно, hot-path-safe) в api/workers — НЕ `flags.ENABLE_*`. Реестр ключей + дефолты — `packages/shared/src/feature-flags.ts` (`FEATURE_FLAG_DEFAULTS`, все off). Сейчас управляются: `campaign_types`, `agency_sourcing`, `object_storage`, `blogger_matching`. Гейт роутов — `requireFeature(key)` preHandler (404 когда off). Аварийный override: env `FEATURE_<KEY>_FORCE=on|off` (побеждает БД; floor для инцидентов). Дефолт при недоступном сторе — off (fail-safe).
- **Compile-time флаги** — остаются в `packages/shared/src/flags.ts` (продуктовые константы: `ENABLE_LLM_CONTACT_EXTRACTION`, `ENABLE_AUTO_MODE`, `ENABLE_FOLLOWUP_CRON`, `ENABLE_QUALITY_REVIEW`, лимиты).
- Обязательные env: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `TG_API_ID`, `TG_API_HASH`.
- Опциональные: `SCRAPECREATORS_API_KEY`, `YANDEX_*`, `OPENROUTER_API_KEY`, `SENTRY_DSN`, `LOG_LEVEL`, `S3_*`, `FEATURE_<KEY>_FORCE`.

## PR-чеклист

- [ ] `pnpm typecheck && pnpm lint && pnpm test` зелёные
- [ ] Если менялась схема БД — приложена миграция, описано в PR
- [ ] Новый агент — есть сид в `agent_config`, тест с моком LLM, обновлён `AGENTS.md`
- [ ] Новая платформа — реализован `PlatformAdapter`, добавлены фикстуры, обновлён `DESIGN.md`
- [ ] TG-клиент — обновлены моки
- [ ] Не добавлены секреты в коде/логах
- [ ] Изменения, видимые оператору — упомянуты в `CHANGELOG.md`
