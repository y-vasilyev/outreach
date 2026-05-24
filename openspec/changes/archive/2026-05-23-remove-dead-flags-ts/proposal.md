## Why

`packages/shared/src/flags.ts` объявляет 8 «compile-time» констант (`ENABLE_LLM_CONTACT_EXTRACTION`, `ENABLE_AUTO_MODE`, `ENABLE_FOLLOWUP_CRON`, `ENABLE_QUALITY_REVIEW`, `MAX_DRY_RUN_TOKENS`, `DEFAULT_DAILY_MSG_LIMIT`, `DEFAULT_DAILY_NEW_CONTACT_LIMIT`, `WARMUP_STAGES`) плюс тип `FeatureFlag = keyof typeof flags`. Ни одно из этих значений нигде в коде не читается. Проверено: статический grep по всем `*.ts/*.tsx/*.vue` в `packages/` и `apps/` (включая динамический паттерн `flags['…']`) — ноль импортов, ноль обращений; тип `FeatureFlag` тоже не импортируется (его не путать с активным `FeatureFlagKey`/`FeatureFlags` из `feature-flags.ts`).

Original blocker `#2` в team-feedback'е предполагал, что эти константы что-то контролируют и их надо мигрировать в runtime `feature_flag`, чтобы дать админке kill-switch. Реальность: переключать нечего — это незавершённые декларации интентов, которые так и не были подцеплены к продакшен-коду. Миграция мёртвого конфига в runtime — лишняя работа без пользы.

Project-rule из `CLAUDE.md`: «If you are certain that something is unused, you can delete it completely». Удаление мёртвого кода — простой и правильный шаг.

## What Changes

- Удалить файл `packages/shared/src/flags.ts` целиком (8 констант + тип `FeatureFlag`).
- Снять `export * from './flags.js';` в `packages/shared/src/index.ts`.
- Поправить docstring в `packages/shared/src/feature-flags.ts` — убрать ссылку на «оставшиеся compile-time флаги в `flags.ts`», поскольку файла больше нет.
- Поправить `CLAUDE.md` (раздел «Фичефлаги и env»): удалить буллет «Compile-time флаги — остаются в `packages/shared/src/flags.ts`…», так как теперь все флаги — runtime.
- Обновить `CHANGELOG.md`: одна строка в `## Unreleased → ### Removed`.

## Capabilities

### New Capabilities
Нет.

### Modified Capabilities
- `runtime-feature-flags`: дельта-спека убирает упоминание о «оставшихся compile-time флагах» из контекста требования, чтобы спека соответствовала факту (все флаги в системе теперь runtime; compile-time категория ликвидирована).

## Impact

- **Файлы**:
  - `packages/shared/src/flags.ts` — удаляется.
  - `packages/shared/src/index.ts` — снимается строка `export * from './flags.js';`.
  - `packages/shared/src/feature-flags.ts` — правится докстринг.
  - `CLAUDE.md` — удаляется буллет.
  - `CHANGELOG.md` — запись в `### Removed`.
  - `openspec/specs/runtime-feature-flags/spec.md` — дельта.
- **Код приложений** — не затрагивается. Нечего ломать: ни одного потребителя удаляемых символов нет.
- **Тестирование** — `pnpm typecheck && pnpm lint && pnpm test` должны остаться зелёными без правок (нет ни одного теста, который бы импортировал `flags`).
- **Прод-деплой** — изменений в behavior нет, миграций нет.
- **Риски** — низкие. Единственный риск — если будущий разработчик попробует переподнять одно из удалённых «интент»-имён без чтения истории. Митигация: упоминание в CHANGELOG + сама openspec-change в архиве оставляют след для гита/документации.
