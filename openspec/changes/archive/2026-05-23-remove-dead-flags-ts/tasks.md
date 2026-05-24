## 1. Подтверждение мёртвого кода

- [x] 1.1 Прогнать grep по `packages/` и `apps/` (расширения `.ts/.tsx/.vue`) на каждый идентификатор из `flags.ts` (`ENABLE_LLM_CONTACT_EXTRACTION`, `ENABLE_AUTO_MODE`, `ENABLE_FOLLOWUP_CRON`, `ENABLE_QUALITY_REVIEW`, `MAX_DRY_RUN_TOKENS`, `DEFAULT_DAILY_MSG_LIMIT`, `DEFAULT_DAILY_NEW_CONTACT_LIMIT`, `WARMUP_STAGES`, и тип `FeatureFlag`) — убедиться, что ни одного потребителя нет, включая динамический паттерн `flags[' ']`.
- [x] 1.2 Зафиксировать состояние shared package'а: какие именно re-exports затрагиваются (`packages/shared/src/index.ts` → `export * from './flags.js';`).

## 2. Удаление файла и re-export

- [x] 2.1 Удалить `packages/shared/src/flags.ts`.
- [x] 2.2 Снять `export * from './flags.js';` в `packages/shared/src/index.ts`.

## 3. Чистка упоминаний

- [x] 3.1 В `packages/shared/src/feature-flags.ts` поправить докстринг: убрать упоминание о «оставшихся compile-time флагах в `flags.ts`».
- [x] 3.2 В `CLAUDE.md` (раздел «Фичефлаги и env») удалить буллет «Compile-time флаги — остаются в `packages/shared/src/flags.ts`…». Если контекст вокруг требует переписать соседние строки — переписать так, чтобы остался единый раздел про runtime-флаги.
- [x] 3.3 В `packages/shared/package.json` снять subpath export `"./flags": "./src/flags.ts"` (dangling после удаления файла).
- [x] 3.4 В `DESIGN.md` (раздел про runtime-feature-flags) обновить список managed flags и убрать упоминание о том, что compile-time-константы остаются в `flags.ts`.

## 4. Регрессия

- [x] 4.1 `pnpm typecheck` зелёный.
- [x] 4.2 `pnpm lint` зелёный.
- [x] 4.3 `pnpm test` зелёный (не должен сломаться, так как ни один тест не импортирует `flags`).

## 5. Документация

- [x] 5.1 Обновить `CHANGELOG.md`: в `## Unreleased` добавить секцию `### Removed` с записью об удалении мёртвого `flags.ts`.

## 6. Ревью и архив

- [x] 6.1 Запросить ревью через Codex (синхронно через `codex-companion.mjs task`).
- [x] 6.2 Применить замечания.
- [x] 6.3 `openspec archive remove-dead-flags-ts`.
- [x] 6.4 Закоммитить одним коммитом: `chore(shared): delete dead packages/shared/src/flags.ts (no consumers)`.
