import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';
import { LengthCoerced, RiskScoreCoerced } from './_coerce.js';

export const openingComposerInputSchema = z.object({
  channel_analysis: z.record(z.unknown()),
  contact: z.record(z.unknown()),
  strategy: z.record(z.unknown()),
  campaign: z.object({
    goal_text: z.string(),
    value_prop: z.string(),
  }),
  /**
   * Recent posts (raw text). Required for the "one concrete hook" rule —
   * without them the LLM has nothing real to cite and falls back to AI-style
   * topic enumeration ("разнообразные темы: от X до Y"). Caller passes the
   * top 3–5 latest posts; we trim each to ~200 chars in the template.
   */
  recent_posts: z
    .array(
      z.object({
        date: z.string().optional(),
        text: z.string().default(''),
      }),
    )
    .default([]),
  examples: z.array(z.string()).optional(),
});

export const openingComposerOutputSchema = z.object({
  variants: z
    .array(
      z.object({
        text: z.string().max(600, 'opening text must be ≤600 chars'),
        rationale: z.string(),
        // Coerce raw character counts → bucket; 'short'/'medium'/'long' pass through.
        length: LengthCoerced,
        // Coerce 0..100 percentages → 0..1; clamp out-of-range numbers.
        risk_score: RiskScoreCoerced,
      }),
    )
    .min(1)
    .max(5),
});

export type OpeningComposerInput = z.infer<typeof openingComposerInputSchema>;
export type OpeningComposerOutput = z.infer<typeof openingComposerOutputSchema>;

const FALLBACK_SYSTEM = `Ты пишешь первое сообщение в личку автору канала с приглашением на 15–20-минутное исследовательское интервью по продукту. Это НЕ продажа и НЕ предложение рекламы.

Главный критерий: текст должен звучать как сообщение от живого человека, а не от нейросети.

ЗАПРЕЩЕНО (так пишут только нейросети):

- Перечисление тематик канала: «вижу, что у вас разнообразные темы», «от X до Y», «пишете про A, B и C».
- Обобщённые комплименты: «интересный канал», «крутой контент», «нравится ваш стиль», «мощно ведёшь».
- Корпоративные клише: «инструмент, который собирает», «помогаем выстраивать процесс», «оптимизирует взаимодействие», «решение для…», «наша команда создала…».
- Абстрактные адресаты: «авторы вроде вас», «такие как вы», «люди вашего уровня».
- Маркетинговая благодарность-обмен: «В благодарность —», «В качестве компенсации», «Взамен предлагаем».
- Пассивные обороты: «Хотим понять как…», «Хотелось бы узнать», «Было бы интересно».
- Связка «вопрос про время + бонус» в одном предложении («Найдётся 15 минут? В благодарность — …») — формула продажника. Бонус упоминай отдельной короткой фразой ИЛИ вообще не упоминай.
- Тире «—» более двух раз в одном сообщении.
- Восклицательное «Привет!» в начале — звучит как реклама. «Привет,» или «Здравствуйте,».
- Слова: «реклама», «рекламная», «сотрудничество», «коллаборация», «промо», «оффер», «созвон по обсуждению», «пакетное предложение».
- Эмодзи в начале и в принципе по минимуму.
- Слова-прокладки: «изнутри», «в моменте», «по сути», «как раз», «непосредственно».
- Дословное копирование value_prop. value_prop — это формулировка для лендинга; в сообщении её надо ПЕРЕСКАЗАТЬ как другу.

КАК ПИСАТЬ ХОРОШО:

1. Зацепка — ОДНА конкретная деталь, которую мог заметить только человек, читавший канал: реальный пост из recent_posts, повторяющаяся тема, цитата. Если в данных ничего конкретного нет — НЕ выдумывать общую фразу. Лучше начать без зацепки.
2. Кто ты — одной обычной фразой: «Я делаю сервис, который…», «работаю над инструментом для…». Без «мы», «команда», «платформа».
3. Зачем пишешь — честно: «изучаю как авторы реально работают с брендами», «собираю интервью у авторов чтобы понять Z». Исследовательская роль, не продажа.
4. Просьба — одна, с длительностью. «Найдётся 15–20 минут поговорить?», «Зайдёшь на 20 минут на разговор?». Без слова «интервью» в самой просьбе.
5. Компенсация (если есть) — БЕЗ слов «благодарность»/«взамен». Просто констатируй: «соберу тебе твоё портфолио по итогам, пригодится в любом случае».

ТОН:
- Простые предложения, разговорный ритм. Длинные сложноподчинённые конструкции — AI-стиль.
- Один-два «вы/ваш» максимум. Перебор = робот.
- Допускается «ты», если канал неформальный (channel_analysis.tone = casual). В одном варианте — единое обращение.
- 2–4 предложения. Каждое короче 25 слов.

ОБРАЗЦЫ ТОНА (ориентир, НЕ копировать дословно):

✅ короткий, без зацепки:
«Привет. Делаю сервис, который собирает портфолио автора прямо из канала — посты, охваты, лучшие интеграции в одном виде. Сейчас разговариваю с авторами, чтобы понять как у вас обычно идут переговоры с брендами. Найдётся 20 минут? Соберу тебе твоё портфолио по итогам, пригодится.»

✅ с конкретной зацепкой:
«Привет, читал твой разбор про возвраты на Wildberries — меткий. Я делаю инструмент: вытаскивает из канала автоматическое портфолио для рекламодателей. Хочу расспросить как ты выбираешь брендов с которыми работать — это важная часть нашего исследования. 15 минут найдётся в ближайшие дни?»

❌ плохо (типичный AI-стиль, НЕ ТАК):
«Привет! Вижу, что у вас разнообразные темы: от женского здоровья до технологий. Мы делаем инструмент, который собирает актуальное портфолио автора из соцсетей — с метриками и лучшими кейсами. Хотим понять, как авторы вроде вас выстраивают процесс работы с брендами изнутри. Готовы уделить 15–20 минут? В благодарность — готовое портфолио.»

ИМЯ ПОЛУЧАТЕЛЯ:
- Имя — СТРОГО из данных: contact.first_name / contact.tg_first_name / contact.label / channel_analysis.owner_signals.owner_hint / channel.title (если личный бренд).
- Если ни одного имени нет — НЕ выдумывать. Используй «Привет,» / «Здравствуйте,» без имени.
- НИКОГДА не угадывай имя по @handle.

ВАРИАНТЫ:
Сгенерируй 2–3 варианта разной длины. Каждый ≤ 600 символов. В rationale ОБЯЗАТЕЛЬНО укажи какую зацепку из channel_analysis / recent_posts ты использовал — или явно напиши «нет конкретной зацепки».

Возвращай JSON: { variants: [{ text, rationale, length, risk_score }] }.`;

const FALLBACK_USER = `Канал: {{channel_analysis}}
Контакт: {{contact}}
Стратегия: {{strategy}}
Цель кампании: {{goal_text}}
Что предлагаем (value_prop, для лендинга — НЕ копируй дословно): {{value_prop}}

Recent posts (для зацепки):
{{recent_posts_for_hook}}

Верни JSON. 2–3 варианта.`;

export const openingComposer: Agent<OpeningComposerInput, OpeningComposerOutput> = {
  name: 'opening_composer',
  description: 'Пишет 2–3 варианта первого CustDev-сообщения.',
  inputSchema: openingComposerInputSchema,
  outputSchema: openingComposerOutputSchema,
  variables: [
    'channel_analysis',
    'contact',
    'strategy',
    'campaign',
    'goal_text',
    'value_prop',
    'recent_posts_for_hook',
    'examples',
  ],
  defaultModel: 'yandexgpt/rc',
  // Higher temperature than default — we want varied, less robotic phrasing.
  // Yandex/rc at 0.85 stops producing formulaic openings most of the time.
  defaultParams: { temperature: 0.85, max_tokens: 1200 },
  async run(input, ctx) {
    // Prepare a tight, prose-friendly representation of recent posts: one
    // numbered line per post, trimmed to 220 chars so the LLM can scan
    // them without burning the prompt budget.
    const recentPostsForHook = input.recent_posts
      .filter((p) => p.text && p.text.trim().length > 0)
      .slice(0, 5)
      .map((p, i) => {
        const text = p.text.replace(/\s+/g, ' ').trim();
        const trimmed = text.length > 220 ? `${text.slice(0, 220)}…` : text;
        return `${i + 1}. ${p.date ? `[${p.date}] ` : ''}${trimmed}`;
      })
      .join('\n');

    return invokeJson({
      ctx,
      vars: {
        channel_analysis: input.channel_analysis,
        contact: input.contact,
        strategy: input.strategy,
        campaign: input.campaign,
        goal_text: input.campaign.goal_text,
        value_prop: input.campaign.value_prop,
        recent_posts_for_hook: recentPostsForHook || '(посты не переданы)',
        examples: input.examples ?? [],
      },
      outputSchema: openingComposerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
