## 1. Schema и резолвер

- [x] 1.1 Расширить `packages/shared/src/schemas/campaign-type.ts` (`SafetyProfileZ`) полем `hard_block_patterns: z.array(z.object({ id: z.string().min(1), pattern: z.string().min(1).max(200), reason: z.string().min(1), flags: z.string().regex(/^[imu]*$/).optional() })).default([])`.
- [x] 1.2 Расширить `packages/shared/src/campaign-type-resolve.ts` (`ResolvedSafetyContext`) — добавить `hard_block_patterns: Array<{ id, regex: RegExp, reason }>`. В `resolveSafetyContext` парсить каждый паттерн через `new RegExp(pattern, flags)` в `try/catch`, malformed пропускать (без падения).
- [x] 1.3 `LEGACY_SAFETY_CONTEXT.hard_block_patterns = []`.

## 2. SafetyFilter

- [x] 2.1 Расширить `safetyFilterInputSchema` полем `hard_block_patterns: z.array(z.object({ id: z.string(), pattern: z.string(), reason: z.string(), flags: z.string().optional() })).default([])`.
- [x] 2.2 В `SafetyFilter.run()` ДО `invokeJson` (`packages/agents/src/agents/SafetyFilter.ts`) собрать список матчей. Для каждого паттерна: компилировать `RegExp` в `try/catch` (malformed пропускать); если `regex.test(draft)` → добавить `<id>:<reason>` в `reasons`, склеить `reason` в `rewrite_hint`.
- [x] 2.3 Если matches.length > 0 → вернуть `{ allow: false, reasons, risk_score: 1, rewrite_hint }` без LLM-вызова.
- [x] 2.4 Обновить FALLBACK-промпт: упомянуть в System-блоке, что hard-block уже отработал, LLM работает только в advisory-режиме — без изменений к "всегда allow=true".

## 3. Воркеры

- [x] 3.1 В `apps/workers/src/queues/agent-run.ts` (`safetyExtrasForCampaign`) — добавить `hard_block_patterns: ctx.hard_block_patterns.map(p => ({ id: p.id, pattern: p.regex.source, reason: p.reason, flags: p.regex.flags }))` в возврат. NB: hint в SafetyFilter компилирует regex заново — это безопасно (длина и флаги проверены при resolve).
- [x] 3.2 В `apps/workers/src/queues/campaign-dispatcher.ts` — аналогично проброс `hard_block_patterns` в вызов `safetyFilter`.

## 4. Seed

- [x] 4.1 В `packages/db/prisma/seed.ts` у `agency_sourcing` `safetyProfile.hard_block_patterns` добавить 6 паттернов (после расщепления guarantee'я под cap; `agency_fabricated_client` отложен — нет надёжного regex'а без false-positives):
  - `agency_guarantee_verb` — «гарантируем продажи / охваты / подписчиков / просмотры / клики / конверсии / трафик», включая noun-форму «гарантия охвата».
  - `agency_guarantee_adjective` — «гарантированный охват / гарантированные продажи / гарантированный результат».
  - `agency_guarantee_numeric` — «+1000 подписчиков / +500 просмотров / +N конверсий».
  - `agency_guarantee_en` — «guarantee result / reach / sale / view / click / conversion».
  - `agency_time_pressure` — «только сегодня», «осталось N мест», «последнее/последние место» (с lookahead-границей, не `\\b` — ASCII-only в JS), «срочно решай».
  - `agency_payment_mention` — «переведите на/по», «оплата по ссылке/на карту/сейчас», «реквизиты», «номер карты», «банковская карта».
- [x] 4.2 `custdev` `safetyProfile.hard_block_patterns = []` (явный пустой массив, чтобы и в дальнейшем не было ambiguity).

## 5. Тесты

- [x] 5.1 В `packages/agents/src/__tests__/SafetyFilter.test.ts` добавить кейсы:
  - empty `hard_block_patterns` → старое поведение (LLM-advisory).
  - matched pattern → `allow=false`, `risk_score=1`, `reasons` начинается с `id:`.
  - non-matching pattern в присутствии других → LLM-advisory путь работает, `allow=true`.
  - malformed regex в инпуте → пропускается, остальные продолжают работать; нет throw.
- [x] 5.2 (Сознательно пропущен: queue-path — dict-copy без логики; `safetyExtrasForCampaign` покрыт via типовая проверка + ручной regen в `agent-run.ts`/`campaign-dispatcher.ts`, а основная safety-логика покрыта 5 новыми unit-тестами в `SafetyFilter.test.ts`. Если в Codex review всплывёт — добавим.)

## 6. Документация

- [x] 6.1 `CHANGELOG.md` → `## Unreleased → ### Added`: одна запись про hard-block в SafetyFilter.

## 7. Ревью и архив

- [x] 7.1 Регрессия: `pnpm typecheck && pnpm lint && pnpm test`.
- [x] 7.2 Codex review (синхронно через `codex-companion.mjs task`).
- [x] 7.3 Применить замечания.
- [x] 7.4 `openspec archive safety-filter-hard-block --yes`.
- [x] 7.5 Закоммитить: `feat(safety): deterministic hard-block patterns for agency-sourcing`.
