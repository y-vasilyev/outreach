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
        /**
         * Optional LLM-supplied stable identifier for this variant
         * (e.g. `'concise'`, `'value_prop'`). The agent's deterministic
         * post-process normalises this into `variantKey` on every variant
         * — see `ab-opener-variants` change. Operators tuning the prompt
         * may emit semantic keys; absent/blank values fall back to
         * alphabetical (`'A'`, `'B'`, …).
         */
        variant_key: z.string().optional(),
      }),
    )
    .min(1)
    .max(5),
});

/**
 * Schema for the value the composer actually returns to callers — same as
 * the raw LLM-validated schema, but every variant now carries a
 * non-optional `variantKey` filled in by the deterministic post-process.
 * The raw `variant_key` field stays around for round-tripping but
 * downstream consumers (campaign-dispatcher, agent-run, auto-approve)
 * should read `variantKey`.
 *
 * Existing field validation (text ≤600 chars, length / risk_score
 * coercion) is preserved — `AgentRunner` re-parses through this schema
 * after `run()` returns, so anything looser here would silently widen
 * the contract.
 */
export const openingComposerPostprocessedOutputSchema = z.object({
  variants: z
    .array(
      z.object({
        text: z.string().max(600, 'opening text must be ≤600 chars'),
        rationale: z.string(),
        length: LengthCoerced,
        risk_score: RiskScoreCoerced,
        variant_key: z.string().optional(),
        variantKey: z.string().min(1),
      }),
    )
    .min(1)
    .max(5),
});

export type OpeningComposerInput = z.infer<typeof openingComposerInputSchema>;
/**
 * Output type as it appears AFTER the deterministic post-process. Each
 * variant carries a non-optional `variantKey` (alphabetical fallback or a
 * disambiguated LLM-supplied key). The schema describing the raw LLM
 * response is `openingComposerOutputSchema` (without `variantKey`).
 */
export type OpeningComposerOutput = z.infer<typeof openingComposerPostprocessedOutputSchema>;

const FALLBACK_SYSTEM = `Ты пишешь первое сообщение в личку автору канала с приглашением на 15–20-минутное исследовательское интервью по продукту. Это НЕ продажа и НЕ предложение рекламы.

Главный критерий: текст должен звучать как сообщение от живого человека, а не от нейросети.

Главный критерий конверсии: собеседнику должно быть понятно, почему вопрос адресован именно ему, и почему ответить на 15–20 минут не рискованно. Это просьба об опыте, а не мини-презентация сервиса.

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
- Слабые логические мосты: «значит, скорее всего», «наверное», «должно быть», «похоже вы…» — если факта нет в данных, сформулируй как вопрос или не используй.
- Отдельный hook без связи с просьбой. Если зацепка про путешествия, а интервью про рекламные запросы, нужно явно связать их через рабочий процесс автора. Иначе лучше убрать hook.
- Длинный продуктовый питч до просьбы. Продукт — максимум одна короткая фраза, только чтобы объяснить контекст исследования.

КАК ПИСАТЬ ХОРОШО:

1. Зацепка — ОДНА конкретная деталь, которую мог заметить только человек, читавший канал: описание канала (contact.channel_bio), контекст контакта (contact.label/contact.context_note), реальный пост из recent_posts, повторяющаяся тема, цитата. Если в данных ничего конкретного нет — НЕ выдумывать общую фразу. Лучше начать без зацепки.
2. Bridge test: зацепка должна естественно вести к исследовательскому вопросу. Формула: «увидел факт → поэтому хочу спросить про конкретный процесс». Не делай выводы за автора.
3. Кто ты — одной обычной фразой: «Я делаю сервис, который…», «работаю над штукой для…». Без «мы», «команда», «платформа».
4. Зачем пишешь — честно: «собираю короткие разговоры с авторами/менеджерами, чтобы понять как проходит путь от входящего запроса до публикации». Исследовательская роль, не продажа.
5. Просьба — одна, с длительностью. «Получится 15–20 минут поговорить?», «Можно задать несколько вопросов на 15–20 минут?». Не проси «созвониться обсудить».
6. Компенсация (если есть) — БЕЗ слов «благодарность»/«взамен». Просто констатируй: «по итогам соберу портфолио канала, можно будет забрать себе».

ХОРОШАЯ СТРУКТУРА ДЛЯ КОНВЕРСИИ:
- 1 предложение: персональный факт или аккуратная причина обращения.
- 1 предложение: исследовательский контекст, не питч.
- 1 предложение: конкретная просьба на 15–20 минут.
- опционально 1 короткое предложение: что человек получит.

Если пишешь менеджеру/ad_manager:
- Обращайся к менеджеру по имени, если оно есть.
- Не делай вид, что менеджер = автор. Пиши: «вы, похоже, принимаете входящие по каналу» только если это следует из context_note.
- Просьба должна быть про процесс: входящий запрос, бриф, отбор брендов, согласование, публикация, отчётность.

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

✅ сильнее, когда hook связан с процессом:
«Привет, Анастасия. Увидел, что канал вы ведёте вдвоём с Ярославом. Я сейчас разбираюсь, как у авторов устроен путь от входящего запроса до готового поста, особенно когда решения принимаются не в одиночку. Можно задать несколько вопросов на 15–20 минут?»

✅ менеджеру:
«Привет, Кристина. В описании канала вы указаны как контакт для связи, поэтому пишу вам. Я изучаю, как у авторов устроен путь от первого запроса бренда до выхода поста. Получится 15–20 минут поговорить?»

❌ плохо (типичный AI-стиль, НЕ ТАК):
«Привет! Вижу, что у вас разнообразные темы: от женского здоровья до технологий. Мы делаем инструмент, который собирает актуальное портфолио автора из соцсетей — с метриками и лучшими кейсами. Хотим понять, как авторы вроде вас выстраивают процесс работы с брендами изнутри. Готовы уделить 15–20 минут? В благодарность — готовое портфолио.»

❌ плохо (hook не согласован с просьбой):
«Вы с Ярославом — фотографы и путешественники, и канал ведёте вместе. Значит и с брендами, скорее всего, работаете в паре — это как раз интересно. Я делаю сервис: он собирает из канала портфолио с метриками…»
(проблема: «скорее всего» — догадка; продуктовый питч длиннее исследовательской причины; hook про пару не доведён до конкретного вопроса.)

ИМЯ ПОЛУЧАТЕЛЯ:
- Имя — СТРОГО из данных: contact.first_name / contact.recipient_name_hint / contact.label / contact.context_note / channel_analysis.owner_signals.owner_hint / channel.title (если личный бренд).
- Если contact.role = ad_manager и contact.context_note говорит «На связи Кристина» или «менеджер Анна» — обращайся к этому человеку, а не к автору канала.
- Если ни одного имени нет — НЕ выдумывать. Используй «Привет,» / «Здравствуйте,» без имени.
- НИКОГДА не угадывай имя по @handle.

ВАРИАНТЫ:
Сгенерируй 2–3 варианта разной длины. Каждый ≤ 600 символов. В rationale ОБЯЗАТЕЛЬНО укажи какую зацепку из channel_analysis / recent_posts ты использовал — или явно напиши «нет конкретной зацепки».
Каждый вариант должен проходить bridge test: hook → исследовательский вопрос → просьба. Если не проходит, перепиши короче без hook.

Опционально можешь пометить каждый вариант семантическим variant_key (например, "concise", "value_prop", "hook_post"). Это short ASCII-идентификатор для статистики, не текст. Если затрудняешься — поле можно опустить, система сама проставит A/B/C.

Возвращай JSON: { variants: [{ text, rationale, length, risk_score, variant_key? }] }.`;

const FALLBACK_USER = `Канал: {{channel_analysis}}
Контакт: {{contact}}
Стратегия: {{strategy}}
Цель кампании: {{goal_text}}
Что предлагаем (value_prop, для лендинга — НЕ копируй дословно): {{value_prop}}

Описание канала и контекст контакта уже лежат внутри contact.channel_bio / contact.context_note.

Recent posts (для зацепки):
{{recent_posts_for_hook}}

Верни JSON. 2–3 варианта.`;

/**
 * Deterministic post-process for the `variantKey` field on opener composer
 * output. Centralised so `OpeningComposer` and `AgencyOpeningComposer`
 * stay byte-for-byte aligned on the rules described by the
 * `ab-opener-variants` change spec:
 *
 *   1. Take the LLM's optional `variant_key`, `trim()`, cap at 32 chars.
 *   2. Treat blank/whitespace as missing.
 *   3. Deduplicate within the response — first seen wins, later
 *      collisions get `_2`, `_3`, … suffix until unique.
 *   4. Missing keys get the next-free alphabetical fallback — `'A'`,
 *      `'B'`, `'C'`, … skipping any letter that an LLM-supplied key
 *      already claimed. So an LLM-supplied `'A'` does NOT collide with
 *      the fallback `'A'` — the missing slot rolls over to `'B'`.
 *   5. The final key set is guaranteed unique within one composer run.
 *
 * Returns the variants array decorated with a non-optional `variantKey`.
 */
export function assignVariantKeys<V extends { variant_key?: string | undefined }>(
  variants: V[],
): Array<V & { variantKey: string }> {
  const MAX_LEN = 32;
  const used = new Set<string>();
  // First pass: normalise + reserve LLM-supplied keys.
  const normalised: Array<string | undefined> = variants.map((v) => {
    const raw = typeof v.variant_key === 'string' ? v.variant_key.trim() : '';
    if (raw.length === 0) return undefined;
    const capped = raw.slice(0, MAX_LEN);
    let candidate = capped;
    let n = 2;
    while (used.has(candidate)) {
      // Append `_N` suffix, re-capping if the result exceeds MAX_LEN.
      const suffix = `_${n}`;
      const room = MAX_LEN - suffix.length;
      const base = capped.length > room ? capped.slice(0, room) : capped;
      candidate = `${base}${suffix}`;
      n += 1;
    }
    used.add(candidate);
    return candidate;
  });

  // Second pass: fill missing slots with the next free alphabetical key.
  let nextLetter = 0;
  const fallbackKey = (): string => {
    // 'A', 'B', ..., 'Z', 'AA', 'AB', ... — keeps positions readable
    // even past 26 variants (which we cap to 5 anyway, but stay safe).
    while (true) {
      let n = nextLetter;
      let s = '';
      do {
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26) - 1;
      } while (n >= 0);
      nextLetter += 1;
      if (!used.has(s)) {
        used.add(s);
        return s;
      }
    }
  };

  return variants.map((v, i) => {
    const k = normalised[i] ?? fallbackKey();
    return { ...v, variantKey: k };
  });
}

export const openingComposer: Agent<OpeningComposerInput, OpeningComposerOutput> = {
  name: 'opening_composer',
  description: 'Пишет 2–3 варианта первого CustDev-сообщения.',
  inputSchema: openingComposerInputSchema,
  // The agent's public `outputSchema` MUST include the post-processed
  // `variantKey` — `AgentRunner` re-parses `run()`'s return value through
  // this schema and would otherwise strip unknown fields, dropping the
  // attribution we just stamped on every variant (ab-opener-variants).
  outputSchema: openingComposerPostprocessedOutputSchema,
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

    const raw = await invokeJson({
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

    // Deterministic post-process: stamp `variantKey` on every variant.
    // Centralised in `assignVariantKeys` so AgencyOpeningComposer follows
    // the exact same rules (see ab-opener-variants change).
    return { variants: assignVariantKeys(raw.variants) };
  },
};
