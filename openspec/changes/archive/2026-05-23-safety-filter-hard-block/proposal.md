## Why

Сейчас `SafetyFilter` имеет только две hard-block-причины (`max_length_exceeded`, `link_not_allowed`, `recipient_declined_earlier`); LLM-вердикт всегда возвращается с `allow=true` и влияет только на `risk_score` (advisory). Это сознательное решение из исходного дизайна: «LLM кладёт всё подряд по стилю».

Однако для `agency_sourcing` (и любых будущих коммерчески чувствительных типов) advisory недостаточно. AGENTS.md / CLAUDE.md правило №9 явно запрещают для агентского sourcing:

- гарантии результата («гарантирую +N подписчиков», «гарантирую охват X»),
- давление («только сегодня», «срочно», «осталось N мест»),
- выдуманные детали клиента (если в кампании не задан реальный бренд/бриф),
- упоминание платежей/ссылок на оплату до подтверждения оператором.

Эти штуки могут проскочить через LLM в композере (опечатка, дрейф температуры, малая модель), `risk_score` высокий, но `allow=true` → отправилось. На пилоте до 5–10 блогеров это и есть тот самый риск, который надо снять детерминистически до prod-релиза.

## What Changes

- **Расширить `SafetyProfileZ`** новым полем `hard_block_patterns: { id: string, pattern: string, reason: string, flags?: string }[]` — список нечётко регистро-зависимых регэкспов; каждый — отдельная конкретная hard-rule. Для `agency_sourcing` сидим 6 паттернов: гарантия результата (verbal: «гарантируем продажи»), гарантия результата (adjective: «гарантированный охват»), гарантия числового результата («+1000 подписчиков»), guarantee на английском, временное давление / scarcity, упоминание оплаты/перевода до оператора. Каждое правило держится под 200-char cap отдельно (одно «жирное» правило с alternation не прошло бы `HardBlockPatternZ`). `agency_fabricated_client` (упоминание клиента/бренда конкретным именем) рассматривался, но отложен — надёжный regex без ложных срабатываний на «нашего клиента из Москвы» сложно подобрать; вернёмся, когда builder сможет ассистировать с авторингом.
- **В `SafetyFilter` добавить deterministic hard-block ветку** _до_ LLM-проверки: если `hard_block_patterns` сматчился — `allow=false`, `risk_score=1`, `reasons=['<pattern.id>:<pattern.reason>']`, `rewrite_hint` собирается из ясного человеческого описания каждого матча. Никаких substring-эвристик «по вибу» (старая ошибка), только явные паттерны из профиля.
- **Семантика `allow=false` остаётся прежней**: воркеры (`campaign-dispatcher.ts:323`, `agent-run.ts:551+`) уже умеют отбрасывать варианты по `if (!safety.allow) continue;`. Никаких изменений у потребителей.
- **`custdev` тип** получает пустой `hard_block_patterns: []` (поведение не меняется). `agency_sourcing` тип получает осмысленный seed.
- **Тесты**: `packages/agents/src/__tests__/SafetyFilter.test.ts` расширяется кейсами: (a) пустой `hard_block_patterns` → старое поведение; (b) сматчившийся паттерн → `allow=false`, причина наследуется из паттерна; (c) несматчившийся в присутствии других → `allow=true` (advisory путь работает); (d) malformed regex в инпуте → silent skip конкретного паттерна, остальные продолжают работать.

## Capabilities

### New Capabilities
Нет.

### Modified Capabilities
- `agency-sourcing-pipeline`: дельта-спека `SafetyProfileZ` — добавляется поле `hard_block_patterns` и требование детерминированного hard-block в SafetyFilter перед LLM-проверкой. Не меняет существующих требований к advisory-пути или к `forbidden_topics`/`allowed_topics`.

## Impact

- **Файлы**:
  - `packages/shared/src/schemas/campaign-type.ts` — расширяется `SafetyProfileZ`.
  - `packages/shared/src/campaign-type-resolve.ts` — `ResolvedSafetyContext` тоже расширяется (`hard_block_patterns`), `LEGACY_SAFETY_CONTEXT` имеет пустой список.
  - `packages/agents/src/agents/SafetyFilter.ts` — входная schema принимает `hard_block_patterns`, в `run()` добавляется ветка `hardBlockMatches()`.
  - `packages/agents/src/__tests__/SafetyFilter.test.ts` — расширяется.
  - `packages/db/prisma/seed.ts` — у `agency_sourcing` появляется seed-список паттернов.
  - `apps/workers/src/queues/agent-run.ts` (~`safetyExtrasForCampaign`) — пробрасывает `hard_block_patterns` в инпут SafetyFilter.
  - `apps/workers/src/queues/campaign-dispatcher.ts` — то же для outbound-пути.
  - `CHANGELOG.md` — `### Added` в `## Unreleased`.
- **Поведение** — без изменения для `custdev` (паттерны пусты). Для `agency_sourcing` после сида: попытка отправить вариант с гарантией/давлением/упоминанием оплаты будет заблокирована, оператор увидит отброшенный вариант с `reason=<pattern.id>:<pattern.reason>` и `risk_score=1`. Если все варианты заблокированы, диалог уходит оператору через тот же existing path, что и при advisory-провале.
- **Безопасность regex** — Node-RegExp не имеет встроенного ReDoS-таймаута, но паттерны идут от админов через builder/seed (не внешний ввод). Защита через `HardBlockPatternZ`: длина source ≤ 200 chars + flags allowlist `i|m|u`. На каждый паттерн `safeParse` → `try/catch new RegExp(...)`; сломанные silent-skip'аются.
- **Тестирование** — `pnpm typecheck && pnpm test`; цель ≥ 70% веток в `packages/agents` сохраняется.
- **Риски** — низкие. Паттерны явные, opt-in per-type. Худший случай — поломанный regex попадает в БД через builder без UI-валидации; митигация — per-item `HardBlockPatternZ.safeParse` в `resolveSafetyContext` + try/catch RegExp compile, malformed silent-skip'ается без падения и без потери базы профиля (остальные паттерны и `max_length`/`forbidden_topics`/`allowed_topics` сохраняются).
