# DESIGN.md

Архитектура Nosquare Outreach под задачу: «список каналов → контакты → CustDev-приглашения в Telegram».

## Цели и не-цели

**Цели**
- Принимать списки каналов разных платформ (TG, Instagram, YouTube; дальше — TikTok, X).
- Скрейпить описание/посты канала через единый интерфейс.
- Извлекать из описания контакты для рекламы (TG, email, телефон, формы), классифицировать по роли.
- Слать персонализированное приглашение на CustDev-интервью через TG.
- Вести диалог с переключением между авто/подсказки/ручной режим.
- Конфиг агентов и интеграций (endpoint, ключи, лимиты) — из UI.

**Не цели**
- Bot API (нужны user-сессии).
- Email/IG-DM как канал отправки в MVP — попадает в `manual` bucket.
- Multi-tenant SaaS, RLS.
- Полноценная CRM — даём webhook + экспорт.

---

## Высокоуровневая схема

```
                ┌──────────────────┐
                │   Web Admin UI   │
                └────────┬─────────┘
                         │ REST + WS
                ┌────────▼─────────┐
                │   API Gateway    │
                │   (Fastify)      │
                └─┬──────┬─────────┘
                  │      │
          ┌───────▼─┐  ┌─▼────────────┐
          │ Postgres│  │    Redis     │
          └───────▲─┘  │ BullMQ + WS  │
                  │    └─▲──────────┬─┘
                  │      │          │
                  └──────┴──────────┴────────┐
                                             │
                              ┌──────────────▼───────────────┐
                              │           Workers            │
                              │  channel-scrape | extract |  │
                              │  agent | tg-send | listener  │
                              └─┬────┬───────────────┬──────┘
                                │    │               │
                ┌───────────────▼┐ ┌─▼──────────────┐ ┌─▼──────────────┐
                │ Platform       │ │ Agent          │ │  TG Client     │
                │ Adapters       │ │ Orchestrator   │ │  (GramJS pool) │
                │  ├ telegram    │ │ + LLM provider │ │                │
                │  ├ instagram   │ │   Yandex /     │ │                │
                │  └ youtube     │ │   OpenRouter   │ │                │
                └───┬───────┬────┘ └────────────────┘ └────────┬───────┘
                    │       │                                  │
              GramJS ▼       ▼ ScrapeCreators REST       Telegram MTProto
```

---

## Приложения

### `apps/api`
HTTP + WebSocket gateway. Не делает тяжёлой работы — валидирует, авторизует, читает/пишет БД, кладёт задачи в очереди.

- `Fastify` + JWT + WS (Socket.IO).
- Роуты: `/auth`, `/tg-accounts`, `/integrations`, `/endpoints`, `/agents`, `/channels`, `/contacts`, `/campaigns`, `/conversations`, `/messages`, `/users`, `/audit`.
- Все DTO — через `zod` из `packages/shared`.
- Роли: `admin`, `operator`, `viewer`.
- Аудит каждого опасного действия в `audit_log`.

### `apps/workers`
Один процесс — несколько BullMQ-consumer-ов. Очереди:

| Очередь | Кто кладёт | Что делает |
|---|---|---|
| `channel-scrape` | API при загрузке канала / переране | Через `PlatformAdapter` тащит метаданные канала + последние посты. Пишет в `channel.raw_data`. |
| `contact-extract` | scraper после успеха | Запускает пайплайн `extract_contacts` (см. `AGENTS.md`): `ChannelAnalyzer` + `ContactExtractor`. Пишет `channel.analysis` и `contact`-ы. |
| `tg-send` | API/agent-worker/cron | Отправляет конкретный `message.id` через нужный outreach-аккаунт. Учёт лимитов, FloodWait. |
| `tg-listen` | listener-воркер (push) | Нормализует входящее, пишет `message`, триггерит `agent-run` пайплайн `on_inbound`. |
| `agent-run` | разные источники | Гонит указанный пайплайн агентов на сущности. |
| `followup-cron` | scheduler | Тихие диалоги → `NextActionPlanner` → возможно фоллоуап. |
| `metrics-roll` | scheduler | Агрегаты для дашборда (reply-rate, токены, стоимость). |

### `apps/web`
React + Vite + Tailwind + shadcn/ui + TanStack Query.

Страницы:
- **Dashboard** — каналы по статусам, контактов извлечено, активные диалоги, токены/стоимость.
- **TG Accounts** — пул аккаунтов, статусы, лимиты, warmup, добавление (логин по номеру).
- **Integrations** — ScrapeCreators ключ, лимиты, проверка коннекта.
- **Endpoints** — LLM endpoint-ы (Yandex / OpenRouter / OpenAI-compat).
- **Agents** — карточки всех агентов (см. `AGENTS.md`): endpoint, модель, промпты, JSON-schema, fallback, Test, History/Diff.
- **Channels** — список с фильтрами по платформе/статусу/тематике, импорт CSV, превью карточки канала с найденными контактами.
- **Contacts** — список контактов с фильтрами по типу (`tg | email | other`), роли (`owner | ad_manager | ...`), статусу. Контакт открывается рядом со связанным каналом.
- **Campaigns** — конструктор: цель CustDev, value-prop (что предлагаем за интервью), сегмент (фильтр каналов/контактов), агент-оверрайды, расписание, превью первых сообщений.
- **Inbox** (чат-клиент) — список диалогов слева, чат справа, подсказки снизу. Над списком — фильтры (кампания, статус, режим, поиск по контакту/каналу); состояние фильтров живёт в URL (`/inbox?campaignId=…`), так что страница кампании ссылается прямо в её отфильтрованный инбокс. Кнопки: Отправить как есть / Редактировать / Свой текст / Пропустить / Эскалация / Сменить режим.
- **Manual outreach** — bucket контактов, до которых не дотянуться через TG. Агент готовит черновик — оператор копирует и пишет сам.
- **Users** — операторы и роли.
- **Audit** — аудит-лог.

---

## Пакеты

### `packages/platforms`
Интерфейс и реализации для разных соцсетей.

```ts
interface PlatformAdapter {
  platform: 'telegram'|'instagram'|'youtube';
  parseHandle(input: string): { handle: string } | null;     // нормализация ввода
  scrapeChannel(handle: string, ctx: ScrapeCtx): Promise<ChannelSnapshot>;
}

interface ChannelSnapshot {
  platform: string;
  external_id: string;          // chat_id для TG, user_id для IG, channel_id для YT
  handle: string;
  title: string;
  description: string;          // главный текст для извлечения контактов
  links: string[];              // линки из bio (для IG это критично)
  followers?: number;
  posts: Array<{ id, date, text, urls[] }>;  // последние N (5-20)
  raw: unknown;                 // оригинальный ответ API для аудита
}
```

Реализации:
- **`TelegramAdapter`** — через `tg-client`, парсер-аккаунт. Берёт `getFullChannel` (title, about, linked_chat), `getMessages` для последних N постов.
- **`InstagramAdapter`** — REST к ScrapeCreators (`/v1/instagram/profile`, `/v1/instagram/posts`).
- **`YoutubeAdapter`** — REST к ScrapeCreators (`/v1/youtube/channel`, `/v1/youtube/videos`).

`ScrapeCreatorsClient` — общий HTTP-клиент с ключом, ретраями, учётом квоты (метрика `scrapecreators_calls_total`).

Фабрика: `PlatformRegistry.get(platform): PlatformAdapter`. Добавление TikTok = новый файл + регистрация.

### `packages/tg-client`
Тонкая обёртка над GramJS.

- `SessionManager` — загружает зашифрованные сессии из БД, healthcheck (`getMe`), reconnect с бэкоффом.
- `RateLimiter` — per-account token bucket (msg/min, msg/day, new-contact/day).
- `FloodGuard` — централизованно ловит `FLOOD_WAIT_X`, ставит `tg_account.cooldown_until`, паузит очередь.
- Методы (типизированные DTO):
  - `auth.startLogin/confirmCode/confirmPassword`
  - `users.resolve`, `users.getProfile`
  - `channels.getFull`, `channels.getRecentPosts`
  - `messages.send`, `messages.markRead`
  - `dialogs.list`, `dialogs.getHistory`
- Каждый вызов пишет `tg_op_log` (latency, ok, FloodWait — для разбора банов).

### `packages/llm`
```ts
interface LLMProvider {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  completeJson<T>(req: CompletionRequest, schema: ZodType<T>): Promise<T>;
  estimateTokens(text: string): number;
}
```

- `YandexProvider` — REST к Yandex Cloud Foundation Models, `yandexgpt-lite`, `yandexgpt`, `yandexgpt/rc`.
- `OpenRouterProvider` — OpenAI-совместимый.
- `OpenAICompatProvider` — для self-hosted (vLLM, Ollama).

Декораторы: `withRetry`, `withTimeout`, `withFallback(secondary)`, `withTokenAccounting(runId)`.

### `packages/agents`
- Контракт `Agent<TIn, TOut>` (см. `AGENTS.md`).
- `AgentRunner.run(name, input, ctx)` — подгружает `agent_config`, инстанцирует провайдера, рендерит промпты (`{{var}}`), вызывает, валидирует, пишет `agent_run`.
- `Orchestrator` — пайплайны как данные (TS-объекты со steps).
- `Registry` — мапинг имени агента → класс.

### `packages/db`
- `prisma/schema.prisma` — единый источник истины.
- `prisma/seed.ts` — `admin` пользователь, дефолтные `endpoint` (по env), дефолтные `agent_config` всех агентов с готовыми промптами.
- Утилиты `encrypt/decrypt` через `libsodium`.

### `packages/shared`
- `schemas/` — все zod-схемы (используются API, web, agents).
- `types/` — выведенные TS-типы.
- `errors/AppError.ts`.
- `realtime.ts` — типы WS-событий.
- `redact.ts`.

---

## Схема БД (ключевое)

```sql
-- ОПЕРАТОРЫ
user (
  id, email UNIQUE, password_hash,
  role ENUM(admin|operator|viewer),
  settings JSONB, created_at, updated_at
)

-- TG АККАУНТЫ
tg_account (
  id, label, phone UNIQUE, session_encrypted TEXT,
  status ENUM(idle|active|cooldown|banned|need_auth),
  role ENUM(parser|outreach|both),
  daily_msg_limit INT, daily_new_contact_limit INT,
  sent_today_msg INT, sent_today_new INT, day_rolled_at TIMESTAMP,
  cooldown_until TIMESTAMP NULL,
  warmup_started_at TIMESTAMP NULL, warmup_stage INT,
  tags TEXT[], notes TEXT,
  created_at, updated_at
)

-- ИНТЕГРАЦИИ (ScrapeCreators и пр.)
integration (
  id, kind TEXT UNIQUE,            -- 'scrapecreators'
  config_encrypted TEXT,           -- {api_key, base_url, ...}
  enabled BOOL, last_check_at, status TEXT
)

-- LLM ENDPOINT-Ы
endpoint (
  id, name UNIQUE,
  provider ENUM(yandex|openrouter|openai_compat),
  base_url TEXT,
  auth_encrypted TEXT,             -- {api_key, folder_id, iam_token, ...}
  default_headers JSONB,
  rate_limit_rpm INT NULL,
  enabled BOOL DEFAULT true,
  created_at, updated_at
)

-- КАНАЛЫ (ГЛАВНАЯ СУЩНОСТЬ)
channel (
  id,
  platform ENUM(telegram|instagram|youtube),
  external_id TEXT,                -- chat_id / user_id / channel_id
  handle TEXT,                     -- @nosquare, instagram.com/x, youtube.com/@y
  title TEXT, description TEXT,
  links TEXT[],
  followers INT NULL,
  language CHAR(2) NULL,
  raw_data JSONB,                  -- сырой ответ адаптера
  analysis JSONB,                  -- результат ChannelAnalyzer
  status ENUM(new|scraping|scraped|extracting|extracted|ready|done|failed),
  source TEXT,                     -- 'csv:filename' / 'manual' / 'api'
  added_by FK user, added_at,
  scraped_at, last_error TEXT,
  UNIQUE(platform, external_id)
)

-- КОНТАКТЫ (производные от канала)
contact (
  id, channel_id FK,
  type ENUM(tg_username|tg_phone|tg_link|email|website|web_form|other),
  value TEXT,                      -- нормализованное (@username без @, email без пробелов)
  raw_value TEXT,                  -- как было в описании
  label TEXT NULL,                 -- "по рекламе", "manager", "PR" — кусок текста рядом
  role_guess ENUM(owner|ad_manager|generic|bot|unknown),
  confidence NUMERIC,              -- 0..1
  extracted_by ENUM(regex|llm|both),
  reachability ENUM(reachable_tg|manual|unreachable),  -- по типу
  status ENUM(new|qualified|disqualified|contacted|active|finished|invalid|blocked),
  tags TEXT[],
  -- если type=tg_username и удалось зарезолвить
  tg_user_id BIGINT NULL,
  created_at, updated_at,
  UNIQUE(channel_id, type, value)
)

-- КАМПАНИИ (CUSTDEV)
campaign (
  id, name, goal_text TEXT,        -- "20 минут CustDev по продукту X"
  value_prop TEXT,                 -- "доступ к бете / $30 / отчёт"
  target_filter JSONB,             -- сегмент: platform, role_guess, tags, language, ...
  agent_overrides JSONB,           -- map: agent_name -> partial config
  outreach_account_pool BIGINT[],
  schedule JSONB,                  -- {tz, work_hours, days, max_per_day_per_account}
  default_mode ENUM(auto|assisted|manual),
  status ENUM(draft|running|paused|finished),
  created_by FK user, created_at, updated_at
)

-- ДИАЛОГИ
conversation (
  id, tg_account_id FK, contact_id FK, campaign_id FK NULL,
  status ENUM(active|paused|done|failed),
  mode ENUM(auto|assisted|manual),
  assigned_operator_id FK user NULL,
  last_inbound_at, last_outbound_at,
  summary TEXT,
  meta JSONB,                      -- intent_history, sentiment_history
  created_at, updated_at,
  UNIQUE(tg_account_id, contact_id)
)

-- СООБЩЕНИЯ
message (
  id, conversation_id FK, tg_msg_id BIGINT NULL,
  direction ENUM(in|out),
  sender ENUM(contact|ai|operator|system),
  text TEXT, attachments JSONB,
  status ENUM(pending|sending|sent|failed|received),
  suggestion_id FK suggestion NULL,
  operator_id FK user NULL,
  sent_at, created_at,
  INDEX (conversation_id, created_at)
)

-- ПОДСКАЗКИ
suggestion (
  id, conversation_id FK, agent_name TEXT,
  text TEXT, rationale TEXT, score NUMERIC,
  status ENUM(pending|approved|edited|rejected|sent|expired),
  meta JSONB,
  created_at, expires_at,
  INDEX (conversation_id, status)
)

-- АГЕНТЫ
agent_config (
  id, name TEXT UNIQUE,            -- 'channel_analyzer', 'contact_extractor', 'opening_composer', ...
  role TEXT, description TEXT,
  endpoint_id FK endpoint,
  model TEXT,
  system_prompt TEXT,
  user_prompt_template TEXT,
  params JSONB,                    -- {temperature, max_tokens, top_p, json_schema, ...specific}
  fallback_endpoint_id FK endpoint NULL,
  enabled BOOL DEFAULT true,
  version INT DEFAULT 1,
  updated_by FK user, updated_at
)

agent_config_history (
  id, agent_config_id FK, version INT, snapshot JSONB,
  changed_by FK user, changed_at
)

-- ТЕЛЕМЕТРИЯ
agent_run (
  id, agent_name, channel_id FK NULL, contact_id FK NULL, conversation_id FK NULL,
  endpoint_id FK, model,
  input JSONB, output JSONB,
  tokens_in INT, tokens_out INT, cost_usd NUMERIC(10,6),
  latency_ms INT, status ENUM(ok|fallback|failed),
  error TEXT NULL,
  created_at,
  INDEX (agent_name, created_at)
)

tg_op_log (
  id, tg_account_id FK, op TEXT,
  ok BOOL, latency_ms INT, error TEXT NULL, meta JSONB,
  created_at,
  INDEX (tg_account_id, created_at)
)

audit_log (
  id, user_id FK, action TEXT, target_type, target_id,
  payload JSONB, created_at
)
```

Индексы под горячие пути: `channel.status`, `contact.status+reachability`, `conversation.last_inbound_at`, `message.conversation_id+created_at`, `suggestion.conversation_id+status`.

---

## Потоки данных

### 1. Загрузка списка каналов
- Оператор вставляет список / загружает CSV. Каждая строка нормализуется (см. `parseHandle` адаптеров).
- Для каждой строки `upsert channel(platform, external_id|handle, status=new)`, кладётся задача в `channel-scrape`.

### 2. Скрейп канала
- Воркер берёт канал, выбирает адаптер по `platform`.
- TG: через парсер-аккаунт, `getFullChannel` + `getMessages` (последние 10–20 постов).
- IG/YT: через `ScrapeCreatorsClient` (профиль + посты/видео).
- Пишем `channel.raw_data`, `description`, `links`, `posts`, `status=scraped`.
- Кладём в `contact-extract`.

### 3. Извлечение контактов
- Пайплайн `extract_contacts` (детально в `AGENTS.md`):
  1. `ChannelAnalyzer` → `channel.analysis` (тематика, аудитория, тон).
  2. `ContactExtractor`:
     - Regex-предфильтр на `description` + `posts.text` + `links`: `@\w+`, `t\.me/\w+`, email, телефон, http(s).
     - LLM-классификация каждого кандидата: тип, роль (`owner | ad_manager | generic | bot`), уверенность, кусок текста-обоснование.
     - Дедуп (одинаковые `value` в рамках канала схлопываем; усиливаем confidence если найден несколькими способами).
  3. Запись в `contact` с `reachability` (TG → `reachable_tg`, остальное → `manual`).
- `channel.status=extracted`. Если 0 контактов — `failed_no_contacts` (видно в админке, можно ручным контактом дополнить).

### 4. Резолв TG-контактов
- Для всех новых `contact.type=tg_username`/`tg_link` — задача через парсер-аккаунт: `users.resolve` → `tg_user_id`. Если резолв упал (нет такого юзера / приватность) — `status=invalid`.
- Только зарезолвленные доходят до отправки.

### 5. Кампания
- Оператор создаёт кампанию: цель, value-prop, фильтр (`platform IN ..., role_guess IN ..., language=ru, channel.analysis.topic IN ...`), пул outreach-аккаунтов, расписание, режим.
- При запуске — фонoвый «диспетчер» каждые M секунд берёт следующего qualified-контакта по фильтру кампании, выбирает наименее загруженный outreach-аккаунт пула.
- Создаётся `conversation`, запускается пайплайн `outreach_first_message` → 2–3 `suggestion`.
- Если `mode=auto` и top-suggestion прошёл `SafetyFilter` — `message(pending)` + `tg-send` с задержкой `30–180 sec` + рабочие часы.
- Если `assisted/manual` — оператор видит подсказки в Inbox.

### 6. Входящее сообщение
- `listener` ловит → `message(direction=in)` → `agent-run` пайплайн `on_inbound`:
  1. (если давно не обновляли) `ChannelAnalyzer` — обычно нет, пропускаем.
  2. `IntentClassifier` (для CustDev — расширенный набор интентов).
  3. `HandoffDecider`.
  4. По решению: `ReplyComposer` (2 варианта) → `SafetyFilter` → `NextActionPlanner`.
- Подсказки летят оператору по WS.
- Если `auto` и low-risk — авто-отправка.

### 7. Manual outreach (контакты без TG)
- Контакты с `reachability=manual` попадают в отдельный bucket в админке.
- Открывая контакт, оператор получает: данные канала, анализ, сгенерированный черновик `OpeningComposer` под канал (но с пометкой «для email/IG», тон скорректирован), кнопка «скопировать».
- Оператор отправляет вне системы. Может пометить контакт как `contacted` и дальше вести в комментариях. Полноценные диалоги в IG/email — в roadmap.

### 8. Фоллоуап (cron)
- Для активных диалогов без активности > X — `NextActionPlanner` решает: ждать / послать / закрыть.
- Если послать — `ReplyComposer` + `SafetyFilter` → `suggestion`.

---

## Realtime

- `conversation:{id}` — `message.new`, `suggestion.new`, `status.changed`, `mode.changed`.
- `operator:{id}` — назначения, эскалации.
- `admin:dashboard` — апдейты счётчиков.
- Транспорт: Socket.IO + Redis adapter.

Также:
- `channel:{id}` — прогресс скрейпа и извлечения (для UI карточки канала).
- `campaign:{id}` — счётчики кампании.

---

## Безопасность TG-аккаунтов

| Механизм | Как |
|---|---|
| Warmup | `tg_account.warmup_stage` (0..4) определяет дневные лимиты. Переход — по дням и reply-rate. |
| Джиттер | `randomBetween(30, 180) sec` между исходящими + рабочие часы аккаунта. |
| Reply-rate guard | `replies/sent < 0.05` за последние 50 → `cooldown=24h` + алерт. |
| FloodWait | `FloodGuard` ставит `cooldown_until`, паузит очередь по аккаунту. |
| 2FA | Статус `need_auth`, баннер в админке. |
| Device fingerprint | Один раз при создании сессии, кладём в БД. |
| Ротация | Кампания берёт наименее загруженный аккаунт пула в рамках лимитов. |
| Anti-ban metric | Дашборд: % FloodWait, ban-rate, reply-rate, скорость warmup. |

---

## Конфигурация агентов через UI

`/agents` — список карточек. На карточке:

- **Endpoint** — выпадашка из `endpoint`. Для Yandex модели подгружаются (`yandexgpt-lite`, `yandexgpt`, и т.д.). Для OpenRouter — поиск по каталогу.
- **Fallback endpoint**.
- **Model** — текстовое поле с подсказками.
- **System prompt** — textarea, переменные `{{var}}` подсвечиваются. Валидация: все `variables` агента покрыты.
- **User prompt template** — то же.
- **Temperature, max_tokens, top_p**.
- **JSON schema (output)** — для агентов со structured output, валидируется на совместимость с `outputSchema` агента.
- **Specific params** — для `SafetyFilter` это `forbidden_topics`, `escalation_keywords`. Для `ContactExtractor` — `min_confidence`, `enable_llm_classification`. Для `HandoffDecider` — пороги.
- **Test** — модалка с пресетами тестовых input-ов из `agent_test_fixtures`. Реальный вызов с `dry_run=true`, показывает ответ + tokens + latency + cost.
- **Save** — создаёт `agent_config_history`, инкрементит `version`.
- **History/Diff/Rollback**.

Кампании имеют `agent_overrides` (частичный конфиг, мерджится поверх глобального) — позволяет одной кампании иметь свои промпты, не клонируя всё.

---

## Метрики

API отдаёт агрегированную дашборд-статистику JSON-ом на `GET /metrics/dashboard`
(см. секцию M9 ниже). Прометеевский экспортер `/metrics` в текстовом формате —
отложен; перечисленные ниже серии описывают целевую модель метрик, а не текущий
endpoint:

- `tg_send_total{account, status}`, `tg_floodwait_seconds_total{account}`
- `agent_run_duration_seconds{agent}`, `agent_tokens_total{agent, direction}`, `agent_cost_usd_total{agent, endpoint}`
- `channel_scrape_total{platform, status}`, `scrapecreators_calls_total{endpoint}`
- `contacts_extracted_total{role_guess, type}`
- `conversation_status{status}`, `conversation_mode{mode}`
- `reply_rate{campaign, account}`
- `queue_depth{queue}`, `queue_jobs_total{queue, status}`

Алерты: FloodWait > 1ч/сутки, reply-rate ниже порога, ScrapeCreators 4xx/5xx, агент failed > N/час, очередь `tg-send` > Y, LLM-стоимость > Z $/час.

---

## Что отложили

- mTLS между сервисами.
- Шардинг listener-а > 50 сессий.
- Voice/media в исходящих.
- Multi-tenant (org_id + RLS).
- Email/IG-DM/YT отправка — каналы для следующих итераций.
- A/B-тесты опенеров (сейчас — через ручные оверрайды кампаний).

---

## Agency sourcing & matching (campaign types)

Расширение под вторую модель работы — агентство по размещению рекламы — поверх
CustDev. Реализовано как **реестр типов кампаний** (`campaign_type`), а не
второй хардкод-режим. Всё новое — за фичефлагами (`ENABLE_CAMPAIGN_TYPES`,
`ENABLE_AGENCY_SOURCING`, `ENABLE_OBJECT_STORAGE`, `ENABLE_BLOGGER_MATCHING`,
по умолчанию off) — при выключенных флагах поведение CustDev байт-в-байт.

### Новые сущности БД (миграции 6–7)

```sql
campaign_type (                       -- справочник типов кампаний
  id, key UNIQUE, name, description,
  goal_schema JSONB,                  -- JSON-schema для campaign.goal
  agent_set JSONB,                    -- map: pipeline-role -> { agentName, overrides }
  safety_profile JSONB,               -- forbidden_topics, allowed_topics, allow_links, max_length
  autonomy_policy JSONB,              -- defaultMode, пороги, forceHandoffIntents
  built_in BOOL, enabled BOOL, ...
)
campaign.type_id  FK campaign_type   -- NOT NULL с миграции 7 (backfill → custdev)
campaign.goal     JSONB              -- валидируется против type.goal_schema (для custdev = AJTBD)

blogger_profile (                    -- стандартизованный каталог блогеров
  id, channel_id UNIQUE,
  topics[], languages[], formats[],
  audience JSONB, rate_cards JSONB, reach, avg_views, captured_at, ...
)
profile_data_point (                 -- провенанс: один факт + сырой фрагмент
  id, profile_id FK, field, value JSONB, unit, confidence,
  extracted_by, source_message_id, raw_snippet, captured_at
)
media_asset (                        -- файлы в S3 + снапшоты сырья
  id, conversation_id, profile_id FK, kind, s3_key, mime, bytes, sha256, source_tg_msg_id
)
ad_brief (                           -- входящая заявка на рекламу
  id, topic, audience_target, budget, formats[], geo[], deadline, notes
)
match_result (                       -- ранжированные кандидаты под бриф (аудит)
  id, brief_id FK, profile_id FK, score, rationale, reranked_by_llm
)
```

`custdev` AJTBD больше не обязателен на каждой кампании концептуально — это
`goal_schema` типа `custdev`. На on_inbound/followup worker берёт AJTBD-вью
напрямую из `campaign.goal` через хелпер `extractAjtbdView` (`packages/shared/
src/schemas/ajtbd.ts`): для `custdev` это passthrough AJTBD-формы; для других
типов (agency_sourcing, builder-authored) — scaffold из `goalText`/`valueProp`,
чтобы агенты `ReplyComposer`/`HandoffDecider`/`GoalFitEvaluator` всегда
получали well-formed `CampaignAjtbd` на входе. Legacy-колонка `campaign.ajtbd`
дропнута миграциями `9b_backfill_campaign_goal_from_ajtbd` +
`9c_drop_campaign_ajtbd` (см. archived openspec change
`drop-campaign-ajtbd-column`).

### Object storage (`packages/storage`)

`ObjectStore` — обёртка над S3-совместимым SDK (MinIO в dev, `S3_*` env),
ленивая и за `ENABLE_OBJECT_STORAGE`. Ключи `bloggers/{profileId}/{assetId}`.
Доступ из UI — только через presigned URL (API выдаёт короткоживущие GET/PUT),
креды не логируются (`redact()`). Входящие файлы из TG: `tg-listen` качает
байты через `tg-client.downloadInboundMedia` → `putObject` → `media_asset`
(s3_key проставляется только при успешной загрузке, иначе honest-pending +
API отдаёт 409 вместо мёртвой ссылки). Сырые ответы (текст + распарсенный
JSON) снапшотятся в S3 детерминированным ключом. При выключенном/недоступном
сторадже — лог-варнинг, диалог не падает.

### Подбор (matching)

`ad_brief` → детерминированный prefilter по `blogger_profile` (overlap по
теме/гео/форматам + отсечение over-budget по релевантному прайсу) → взвешенный
скоринг с rationale → `match_result`. Опциональный LLM-реранк (`BloggerMatcher`)
ограничен топ-N (по умолчанию off, детерминированный путь без LLM). Всё за
`ENABLE_BLOGGER_MATCHING`. API: `POST /ad-briefs`, `POST /ad-briefs/:id/match`.

### Метрики

`dashboardService.stats()` отдаёт блок `agency`: `bloggersProfiled`,
`profileDataPoints` (+ разбивка по `field`), `matchRequests`, `agentCost7dUsd`
(builder/extractor/matcher). Нули, пока фичи не используются.

---

## Runtime feature flags

Operational rollout/kill-switch flags live in the DB (`feature_flag`), not in
code — consistent with how endpoints/agents/types are configured (the
`runtime-feature-flags` change). Toggled from the admin UI (Settings →
Features) without a redeploy; instant kill-switch for risky outreach.

```sql
feature_flag ( key PK, enabled BOOL, description, updated_by_id, updated_at )
```

- **Registry**: closed set of keys + defaults in `packages/shared/src/feature-flags.ts`
  (`FEATURE_FLAG_DEFAULTS`, all OFF). Currently managed: `campaign_types`,
  `agency_sourcing`, `object_storage`, `blogger_matching`, `channel_discovery`.
  Unknown key → off. There is no parallel compile-time flag module: future
  operational toggles get a `FEATURE_FLAG_DEFAULTS` entry + a seeded
  `feature_flag` row.
- **Accessor** (`FeatureFlags`, shared, IO injected per app): synchronous
  `get(key)` from an in-memory cache (hot-path safe), `init()`/`refresh()`,
  `snapshot()`. Resolution order: **env force > cached DB value > default-off**.
  Fail-safe: store unreachable ⇒ defaults (never auto-enables).
- **Cross-process invalidation**: api + workers each hold a cache; a write
  publishes to Redis channel `feature_flags:changed`; every subscriber
  reloads (also on (re)connect, closing the reconnect window). Reuses the
  existing Redis (BullMQ / Socket.IO) — no new dependency.
- **Route gating**: flag-gated route plugins are registered unconditionally
  and gated by a `requireFeature(key)` preHandler that returns a plain 404
  when off — so toggling changes availability without a restart, and the web
  distinguishes "feature off" from a real not-found.
- **Env emergency override**: `FEATURE_<KEY>_FORCE=on|off` overrides the DB
  value (incident kill-floor); pinned overrides are logged at startup.
- **Admin control plane**: `GET/PATCH /feature-flags` (admin only, registered
  unconditionally — never self-gated). A toggle updates the row + writes
  `audit_log` atomically (one transaction), then publishes invalidation. The
  UI shows non-blocking readiness hints (e.g. `object_storage` needs `S3_*`).
  `GET /config` serves the public, secret-free flag snapshot the web gates UI on.

---

## Channel discovery (web search)

Front of the sourcing funnel: discover candidate blogger channels by niche via
the **Yandex Search API** and feed them into the existing intake
(channel-discovery-search change). Behind the runtime flag `channel_discovery`
(default off).

- **`packages/platforms/discovery`**: `YandexSearchClient` (async `searchAsync`
  submit → poll the operation, bounded → decode base64 result XML →
  `{url,title,snippet}[]`; never logs the key) + `extractCandidates` (results →
  platform handles via the existing `parseHandle`, dropping system/invite paths,
  with in-batch dedup and an optional platform filter).
- **`apps/api` discovery service + `POST /discovery/search`**: load+decrypt the
  `yandex_search` integration → search → extract candidates (≤ `limit`) → upsert
  NEW `channel(status='new', source='search:<query>')` + enqueue the existing
  `channel-scrape`; known channels are not duplicated or re-enqueued. Route is
  registered unconditionally and gated by `requireFeature('channel_discovery')`
  + admin/operator role; the action is audited.
- **Key**: stored encrypted as `integration(kind='yandex_search')` (separate
  Search-API-scoped key — distinct role from the LLM key). Configurable from
  env-seed / UI; never committed.
- **Downstream unchanged**: discovered channels flow through scrape →
  `ChannelAnalyzer`/`ContactExtractor` → operator review like any other channel.
- **e2e**: an env-gated test closes the scenario against the real Search API +
  DB (skips offline).
