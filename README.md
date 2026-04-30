# Nosquare Outreach

Система для CustDev-аутрича владельцам каналов. На вход — список каналов (Telegram, Instagram, YouTube). На выходе — отправленные приглашения на интервью по продукту и живой диалог в Telegram с подсказками от ИИ-агентов.

> Архитектура — [`DESIGN.md`](./DESIGN.md). Агенты — [`AGENTS.md`](./AGENTS.md). Гайд для Claude Code — [`CLAUDE.md`](./CLAUDE.md).

## Что делает

1. **Принимает список каналов** (CSV, вставка списка хендлов, REST API). Каждый канал помечен платформой: `tg | instagram | youtube`.
2. **Скрейпит каждый канал** через платформенный адаптер:
   - Telegram — через [GramJS](https://github.com/gram-js/gramjs) от имени парсер-аккаунта (берём `title`, `about`, `linked_chat`, последние посты).
   - Instagram, YouTube — через [ScrapeCreators](https://scrapecreators.com) REST API (биография, ссылки, последние посты/видео).
3. **Извлекает контакты** из описания и постов. Агент `ContactExtractor` гибридом regex + LLM достаёт `@username`, `t.me/...`, email, формы, телефоны, ссылки на «рекламного менеджера». Каждому контакту проставляет тип, роль (`owner | ad_manager | generic | bot`), уверенность.
4. **Анализирует тему канала** (`ChannelAnalyzer`): тематика, аудитория, формат, тон. Нужно для персонализации первого сообщения.
5. **Пишет приглашение на CustDev-интервью** (`OpeningComposer`) с учётом тематики канала и роли контакта. 2–3 варианта, проверенные `SafetyFilter`-ом на «не звучит как продажа рекламы».
6. **Отправляет через outreach-аккаунт** в Telegram (с warmup, лимитами и джиттером). Контакты, у которых нет TG, попадают в bucket `manual` — оператор пишет сам в IG-DM или по email, агент готовит текст.
7. **Ведёт диалог** в смешанном режиме: ИИ предлагает ответы, оператор одобряет/правит/пишет своё. Эскалация на оператора по триггерам (агрессия, просьба «позови человека», низкая уверенность подряд).

## Ключевые решения

- **Канал — первая сущность.** Контакты — связанная таблица. Один канал ⇒ N контактов с приоритетом.
- **Платформенные адаптеры за единым интерфейсом.** Добавить TikTok/X — это новый класс, без правок ядра.
- **Парсер-аккаунты ≠ outreach-аккаунты.** Парсим с одних, пишем с других — иначе ловим бан.
- **Тон CustDev, не продажный.** В промптах и в `SafetyFilter` это зашито жёстко.
- **Конфиг агентов из UI.** Endpoint, модель, system/user prompt, температура, JSON-schema, fallback — всё меняется в админке без релиза.

## Стек

| Слой | Технологии |
|---|---|
| Backend | Node.js 20+, TypeScript, Fastify, BullMQ, Pino, Zod |
| Telegram | GramJS (MTProto, user-аккаунты) |
| IG / YT | ScrapeCreators REST API |
| Хранилище | PostgreSQL 16, Redis 7 |
| Frontend | React 18, Vite, TanStack Query, Tailwind, shadcn/ui |
| Realtime | Socket.IO + Redis adapter |
| LLM | Yandex Cloud Foundation Models, OpenRouter |
| Деплой | Docker Compose |

## Структура (pnpm workspaces + turbo)

```
nosquare-outreach/
├── apps/
│   ├── api/              # HTTP API + WS gateway (Fastify)
│   ├── web/              # Админка + чат-клиент (React)
│   └── workers/          # Воркеры: scrape, extract, agent, send, listener
├── packages/
│   ├── platforms/        # PlatformAdapter: telegram (GramJS), instagram, youtube (ScrapeCreators)
│   ├── tg-client/        # Тонкая обёртка над GramJS: пул сессий, лимиты, FloodGuard
│   ├── agents/           # Контракт Agent + оркестратор + конкретные агенты
│   ├── llm/              # Провайдеры: yandex, openrouter, retry/fallback
│   ├── db/               # Prisma schema + миграции + сиды
│   └── shared/           # Zod-схемы, типы, errors, redact
├── infra/
│   ├── docker-compose.yml
│   └── compose.dev.yml
├── .env.example
└── package.json
```

## Быстрый старт

```bash
pnpm install
docker compose -f infra/compose.dev.yml up -d        # postgres + redis
cp .env.example .env                                  # см. список ниже
pnpm db:migrate
pnpm db:seed                                          # admin/admin + дефолтные agent_config
pnpm dev                                              # api :4000, web :5173, workers
```

Минимальный путь до первой отправки:
1. `/endpoints` — добавить Yandex или OpenRouter endpoint (ключ).
2. `/agents` — проверить, что все агенты получили endpoint (по дефолту берут из env).
3. `/tg-accounts` — добавить парсер-аккаунт и outreach-аккаунт (логин по номеру + код + 2FA).
4. `/integrations` — вписать ключ ScrapeCreators (для IG/YT).
5. `/channels` — загрузить CSV или вставить список (`@channel_handle`, `instagram.com/...`, `youtube.com/@...`).
6. Запустить scrape → дождаться `extracted` → проверить контакты в `/contacts`.
7. `/campaigns` — создать кампанию: цель = «CustDev по продукту X», value-prop = «20 минут, доступ к бете / $30 / отчёт», фильтр по платформе/тематике/роли.
8. Прогнать превью первых сообщений → `Run`.

## Env

```
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
ENCRYPTION_KEY=                 # 32 байта в base64

TG_API_ID=                      # из my.telegram.org
TG_API_HASH=

SCRAPECREATORS_API_KEY=

YANDEX_DEFAULT_FOLDER_ID=
YANDEX_API_KEY=                 # опц., можно создать endpoint в UI
OPENROUTER_API_KEY=             # опц., можно создать endpoint в UI

LOG_LEVEL=info
LOG_MESSAGE_BODIES=false
```

## Скрипты

```
pnpm dev / dev:api / dev:web / dev:workers
pnpm build / test / test:e2e / lint / typecheck
pnpm db:migrate / db:seed / db:studio / db:reset
```

## Безопасность

- TG-сессии и API-ключи шифруются `libsodium` (`ENCRYPTION_KEY`).
- В production-логах нет текстов сообщений — только id и метаданные.
- TG-аккаунты на warmup-ах со сниженными лимитами; FloodWait → авто-cooldown; reply-rate guard режет аккаунт при подозрительной динамике.
- `SafetyFilter` блокирует исходящие, которые могут быть восприняты как продажа/реклама — это критично, чтобы CustDev не получил репорт за спам.

## Что вне скоупа MVP

- Email/IG-DM/YT-комментарии как канал отправки (только Telegram). NonTG-контакты копятся в `manual` bucket.
- Bot API (нужны user-сессии).
- Multi-tenant: один деплой = одна команда.
- Voice/media в исходящих.

## Roadmap (после MVP)

- Email-канал отправки (через Postmark/Resend), отдельный SafetyFilter под email-этикет.
- Адаптер TikTok через ScrapeCreators.
- Few-shot обучение по фидбеку оператора (👍/👎 на каждую подсказку → шотов в контекст композеров).
- Долговременная «память» по контакту между кампаниями.
