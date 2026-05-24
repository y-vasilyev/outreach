<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery } from '@tanstack/vue-query';
import Modal from '../../components/Modal.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import SelectInput from '../../components/SelectInput.vue';
import MultiToggle from '../../components/MultiToggle.vue';
import TagInput from '../../components/TagInput.vue';
import Icon from '../../components/Icon.vue';
import AgencyGoalEditor from './AgencyGoalEditor.vue';
import { api } from '../../lib/api';
import { useFlags } from '../../lib/config';
import { isFeatureOff } from '../../lib/featureGate';
import { toast } from '../../lib/toast';
import type { Campaign } from './types';
import type { CampaignType } from '../campaign-types/types';
import type { TgAccount } from '../tg-accounts/types';

const props = defineProps<{ open: boolean; campaign: Campaign | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

// ─── Top-level fields ───
const name = ref('');
const goal = ref('');
const valueProp = ref('');
const mode = ref<'auto' | 'semi_auto' | 'assisted' | 'manual'>('assisted');

// ─── Campaign type (agency-sourcing-matching) ───
// Flag-gated server-side: GET /campaign-types is 404 when ENABLE_CAMPAIGN_TYPES
// is off. In that case we degrade to the legacy custdev-only form (no selector,
// AJTBD editor only) instead of crashing.
const typeId = ref<string>('');

const flags = useFlags();

const { data: campaignTypesRaw, error: typesError } = useQuery({
  queryKey: ['campaign-types'],
  queryFn: () => api.get<CampaignType[]>('/campaign-types'),
  // Only fetch when the registry flag is on and the form is open; with the flag
  // off we skip the request and degrade to the legacy custdev-only form.
  enabled: computed(() => props.open && flags.value.campaignTypes),
  retry: false,
  staleTime: 60_000,
});

// Available when the flag is on AND the endpoint didn't answer flag-off 404.
const typesAvailable = computed(
  () => flags.value.campaignTypes && !isFeatureOff(typesError.value),
);
const campaignTypes = computed<CampaignType[]>(() => campaignTypesRaw.value ?? []);
const typeOptions = computed(() =>
  campaignTypes.value.map((t) => ({ value: t.id, label: t.name })),
);
const selectedType = computed<CampaignType | null>(
  () => campaignTypes.value.find((t) => t.id === typeId.value) ?? null,
);
const selectedTypeKey = computed(() => selectedType.value?.key ?? 'custdev');

// ─── Agency goal fields (agency_sourcing type) ───
const agencyTargetDataPoints = ref<string[]>([]);
const agencyClientBrief = ref('');

// ─── Generic goal fallback (unknown types) — raw JSON ───
const goalJson = ref('{}');
const goalJsonError = ref<string | null>(null);

// AJTBD framing — propagated into ReplyComposer / HandoffDecider /
// SafetyFilter / GoalFitEvaluator on every inbound. Operators see /
// edit it here; the migration scaffolds it from goalText/valueProp
// for legacy campaigns. Empty arrays are valid; missing keys are
// not.
const ajtbdJob = ref('');
const ajtbdWhen = ref('');
const ajtbdDesiredOutcome = ref('');
const ajtbdPush = ref<string[]>([]);
const ajtbdPull = ref<string[]>([]);
const ajtbdAnxieties = ref<string[]>([]);
const ajtbdHabits = ref<string[]>([]);
const ajtbdNonGoals = ref<string[]>([]);

// ─── Target filter (audience) ───
const filterPlatforms = ref<string[]>(['telegram']);
const filterRoles = ref<string[]>(['ad_manager', 'owner']);
const filterLanguages = ref<string[]>([]);
const filterTopics = ref<string[]>([]);
const filterTags = ref<string[]>([]);
const filterMinConfidence = ref<string>('');

// ─── Schedule ───
const scheduleTz = ref('Europe/Moscow');
const scheduleStart = ref('10:00');
const scheduleEnd = ref('20:00');
const scheduleDays = ref<string[]>(['1', '2', '3', '4', '5']);
const scheduleMaxPerDay = ref(25);

// ─── Outreach pool ───
const outreachAccountPool = ref<string[]>([]);

// ─── Advanced (agent overrides) ───
const advancedOpen = ref(false);
const overridesJson = ref('{}');
const overridesError = ref<string | null>(null);

// ─── Reference data: TG accounts for the pool picker ───
const { data: tgAccounts } = useQuery({
  queryKey: ['tg-accounts'],
  queryFn: () => api.get<TgAccount[]>('/tg-accounts'),
  enabled: computed(() => props.open),
  staleTime: 60_000,
});

const outreachAccounts = computed(() =>
  (tgAccounts.value ?? []).filter((a) => a.role === 'outreach' || a.role === 'both'),
);

// ─── Static option lists ───
const PLATFORMS = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'youtube', label: 'YouTube' },
];
const ROLES = [
  { value: 'owner', label: 'owner' },
  { value: 'ad_manager', label: 'ad_manager' },
  { value: 'generic', label: 'generic' },
  { value: 'bot', label: 'bot' },
];
const LANGS = [
  { value: 'ru', label: 'ru' },
  { value: 'en', label: 'en' },
  { value: 'other', label: 'other' },
];
const DAYS = [
  { value: '1', label: 'пн' },
  { value: '2', label: 'вт' },
  { value: '3', label: 'ср' },
  { value: '4', label: 'чт' },
  { value: '5', label: 'пт' },
  { value: '6', label: 'сб' },
  { value: '0', label: 'вс' },
];
const TIMEZONES = [
  { value: 'Europe/Moscow', label: 'Europe/Moscow (МСК)' },
  { value: 'Europe/Kaliningrad', label: 'Europe/Kaliningrad' },
  { value: 'Asia/Yekaterinburg', label: 'Asia/Yekaterinburg' },
  { value: 'Asia/Novosibirsk', label: 'Asia/Novosibirsk' },
  { value: 'Asia/Vladivostok', label: 'Asia/Vladivostok' },
  { value: 'UTC', label: 'UTC' },
];
const MIN_CONF = [
  { value: '', label: '— любая —' },
  { value: '0.5', label: '≥ 0.50' },
  { value: '0.7', label: '≥ 0.70' },
  { value: '0.85', label: '≥ 0.85' },
];

watch(
  [() => props.open, () => props.campaign],
  ([open, c]) => {
    if (!open) return;
    if (c) {
      name.value = c.name;
      goal.value = c.goalText;
      valueProp.value = c.valueProp;
      mode.value = c.defaultMode;
      typeId.value = c.typeId ?? '';

      const cg = (c.goal ?? {}) as {
        target_data_points?: unknown;
        client_brief?: unknown;
      };
      agencyTargetDataPoints.value = Array.isArray(cg.target_data_points)
        ? (cg.target_data_points as string[])
        : [];
      agencyClientBrief.value = typeof cg.client_brief === 'string' ? cg.client_brief : '';
      goalJson.value = JSON.stringify(c.goal ?? {}, null, 2);

      // CustDev's `goal` IS the AJTBD shape. After
      // `drop-campaign-ajtbd-column` the AJTBD editor fields are sourced
      // from `c.goal`; non-AJTBD goals (agency_sourcing etc.) leave the
      // fields with reasonable fallbacks from goalText / valueProp.
      const g = (c.goal ?? {}) as {
        job?: string;
        when?: string;
        desired_outcome?: string;
        forces?: { push?: string[]; pull?: string[]; anxieties?: string[]; habits?: string[] };
        non_goals?: string[];
      };
      ajtbdJob.value = g.job ?? c.goalText;
      ajtbdWhen.value = g.when ?? '';
      ajtbdDesiredOutcome.value = g.desired_outcome ?? c.valueProp;
      ajtbdPush.value = g.forces?.push ?? [];
      ajtbdPull.value = g.forces?.pull ?? [];
      ajtbdAnxieties.value = g.forces?.anxieties ?? [];
      ajtbdHabits.value = g.forces?.habits ?? [];
      ajtbdNonGoals.value = g.non_goals ?? [];

      const f = (c.targetFilter ?? {}) as {
        platforms?: string[];
        roleGuess?: string[];
        languages?: string[];
        topics?: string[];
        tags?: string[];
        minConfidence?: number;
      };
      filterPlatforms.value = f.platforms ?? [];
      filterRoles.value = f.roleGuess ?? [];
      filterLanguages.value = f.languages ?? [];
      filterTopics.value = f.topics ?? [];
      filterTags.value = f.tags ?? [];
      filterMinConfidence.value = f.minConfidence != null ? String(f.minConfidence) : '';

      const s = c.schedule ?? {};
      scheduleTz.value = s.tz ?? 'Europe/Moscow';
      scheduleStart.value = s.workHours?.start ?? '10:00';
      scheduleEnd.value = s.workHours?.end ?? '20:00';
      scheduleDays.value = (s.days ?? [1, 2, 3, 4, 5]).map(String);
      scheduleMaxPerDay.value = s.maxPerDayPerAccount ?? 25;

      outreachAccountPool.value = c.outreachAccountPool ?? [];

      overridesJson.value = JSON.stringify(c.agentOverrides ?? {}, null, 2);
    } else {
      name.value = '';
      goal.value = '';
      valueProp.value = '';
      mode.value = 'assisted';
      typeId.value = '';
      agencyTargetDataPoints.value = [];
      agencyClientBrief.value = '';
      goalJson.value = '{}';
      ajtbdJob.value = '';
      ajtbdWhen.value = '';
      ajtbdDesiredOutcome.value = '';
      ajtbdPush.value = [];
      ajtbdPull.value = [];
      ajtbdAnxieties.value = [];
      ajtbdHabits.value = [];
      ajtbdNonGoals.value = [];
      filterPlatforms.value = ['telegram'];
      filterRoles.value = ['ad_manager', 'owner'];
      filterLanguages.value = [];
      filterTopics.value = [];
      filterTags.value = [];
      filterMinConfidence.value = '';
      scheduleTz.value = 'Europe/Moscow';
      scheduleStart.value = '10:00';
      scheduleEnd.value = '20:00';
      scheduleDays.value = ['1', '2', '3', '4', '5'];
      scheduleMaxPerDay.value = 25;
      outreachAccountPool.value = [];
      overridesJson.value = '{}';
    }
    overridesError.value = null;
    advancedOpen.value = false;
  },
  { immediate: true },
);

// Default the type selector to `custdev` for new campaigns once types load,
// so the form keeps a sensible default when ENABLE_CAMPAIGN_TYPES is on.
watch(
  [campaignTypes, () => props.open, () => props.campaign],
  ([types, open, c]) => {
    if (!open || c || typeId.value) return;
    const custdev = types.find((t) => t.key === 'custdev');
    if (custdev) typeId.value = custdev.id;
  },
  { immediate: true },
);

const canSubmit = computed(() => !!name.value && !!goal.value && !!valueProp.value);

// Build the type-specific `goal` object from the active editor. When
// `typesAvailable` is false the server still defaults to CustDev (flag
// off, registry dark), so we send an AJTBD-shaped `goal` here too —
// otherwise the AJTBD editor fields the operator just filled would be
// silently dropped and only the goalText/valueProp scaffold would
// reach the DB. After `drop-campaign-ajtbd-column` there is no longer
// a separate `ajtbd` column to fall back to.
function buildCustdevGoal(): Record<string, unknown> {
  return {
    job: ajtbdJob.value || goal.value,
    when: ajtbdWhen.value,
    forces: {
      push: ajtbdPush.value,
      pull: ajtbdPull.value,
      anxieties: ajtbdAnxieties.value,
      habits: ajtbdHabits.value,
    },
    desired_outcome: ajtbdDesiredOutcome.value || valueProp.value,
    non_goals: ajtbdNonGoals.value,
  };
}

function buildGoal(): Record<string, unknown> | undefined {
  if (!typesAvailable.value) {
    // Registry is dark — server forces custdev. Still send the AJTBD-
    // shaped goal so the editor's content survives the request.
    return buildCustdevGoal();
  }
  const key = selectedTypeKey.value;
  if (key === 'agency_sourcing') {
    return {
      target_data_points: agencyTargetDataPoints.value,
      ...(agencyClientBrief.value ? { client_brief: agencyClientBrief.value } : {}),
    };
  }
  if (key === 'custdev') {
    return buildCustdevGoal();
  }
  // Unknown type: operator-authored JSON.
  try {
    goalJsonError.value = null;
    return JSON.parse(goalJson.value || '{}');
  } catch (e) {
    goalJsonError.value = (e as Error).message;
    throw e;
  }
}

const mut = useMutation({
  mutationFn: () => {
    let agentOverrides: unknown = {};
    try {
      agentOverrides = JSON.parse(overridesJson.value || '{}');
      overridesError.value = null;
    } catch (e) {
      overridesError.value = (e as Error).message;
      throw e;
    }

    const targetFilter: Record<string, unknown> = {};
    if (filterPlatforms.value.length) targetFilter.platforms = filterPlatforms.value;
    if (filterRoles.value.length) targetFilter.roleGuess = filterRoles.value;
    if (filterLanguages.value.length) targetFilter.languages = filterLanguages.value;
    if (filterTopics.value.length) targetFilter.topics = filterTopics.value;
    if (filterTags.value.length) targetFilter.tags = filterTags.value;
    if (filterMinConfidence.value) targetFilter.minConfidence = Number(filterMinConfidence.value);

    const schedule = {
      tz: scheduleTz.value,
      workHours: { start: scheduleStart.value, end: scheduleEnd.value },
      days: scheduleDays.value.map((d) => Number(d)).sort(),
      maxPerDayPerAccount: scheduleMaxPerDay.value,
    };

    // After `drop-campaign-ajtbd-column` the API no longer accepts an
    // `ajtbd` field — for CustDev the AJTBD content is embedded inside
    // the type-specific `goal` (see `buildGoal()` below).
    const goalObj = buildGoal();

    const body: Record<string, unknown> = {
      name: name.value,
      goalText: goal.value,
      valueProp: valueProp.value,
      defaultMode: mode.value,
      targetFilter,
      agentOverrides,
      schedule,
      outreachAccountPool: outreachAccountPool.value,
    };
    // `typeId` only goes through when the registry is enabled (otherwise
    // the server defaults to custdev). `goal` is ALWAYS sent now — the
    // legacy `ajtbd` column was removed by `drop-campaign-ajtbd-column`,
    // so `buildGoal()` returns a populated AJTBD-shaped goal even on the
    // flag-off CustDev path; sending it preserves the editor's content
    // instead of relying on a goalText/valueProp scaffold.
    if (typesAvailable.value && typeId.value) body.typeId = typeId.value;
    if (goalObj !== undefined) body.goal = goalObj;

    if (props.campaign) return api.patch<Campaign>(`/campaigns/${props.campaign.id}`, body);
    return api.post<Campaign>('/campaigns', body);
  },
  onSuccess: () => {
    toast.success(props.campaign ? 'Кампания обновлена' : 'Кампания создана');
    emit('saved');
  },
  onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
});

function togglePoolAccount(id: string): void {
  const next = new Set(outreachAccountPool.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  outreachAccountPool.value = [...next];
}
</script>

<template>
  <Modal
    :open="props.open"
    size="xl"
    :title="campaign ? 'Редактировать кампанию' : 'Новая кампания'"
    description="Цель — CustDev. SafetyFilter блокирует продажные формулировки автоматически."
    @close="emit('close')"
  >
    <!-- ─── Базовые поля ─── -->
    <div class="card">
      <div class="card-head"><Icon name="flag" :size="12" /><span>Базовые поля</span></div>
      <div class="card-body">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <Field label="Название"><TextInput v-model="name" placeholder="CustDev — B2B SaaS Q2" /></Field>
          <Field
            v-if="typesAvailable && typeOptions.length"
            label="Тип кампании"
            help="Определяет агентов, профиль безопасности и набор полей цели."
          >
            <SelectInput v-model="typeId" :options="typeOptions" placeholder="— выберите тип —" />
          </Field>
          <Field label="Режим по умолчанию">
            <SelectInput
              v-model="mode as string"
              :options="[
                { value: 'auto', label: 'auto — полный авто, тихий фоллбек' },
                { value: 'semi_auto', label: 'semi_auto — авто, иначе подсказка' },
                { value: 'assisted', label: 'assisted — оператор подтверждает' },
                { value: 'manual', label: 'manual — оператор пишет сам' },
              ]"
            />
          </Field>
          <Field label="Цель кампании" style="grid-column: 1 / -1;" help="Что именно ты хочешь получить от респондента.">
            <TextareaInput v-model="goal" :rows="3" placeholder="20 минут CustDev по продукту X с фаундерами B2B SaaS" />
          </Field>
          <Field label="Value-prop (что получит респондент)" style="grid-column: 1 / -1;">
            <TextareaInput v-model="valueProp" :rows="2" placeholder="доступ к бете / $30 / итоговый отчёт по индустрии" />
          </Field>
        </div>
      </div>
    </div>

    <!-- ─── AJTBD framing (custdev / legacy) ─── -->
    <div v-if="!typesAvailable || selectedTypeKey === 'custdev'" class="card" style="margin-top: 12px;">
      <div class="card-head">
        <Icon name="sparkle" :size="12" />
        <span>AJTBD — что делает кампанию своей</span>
        <span class="muted-2" style="margin-left: 6px;">пробрасывается во все агенты диалога</span>
      </div>
      <div class="card-body">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <Field label="Job (что мы хотим сделать)" style="grid-column: 1 / -1;" help='Формула: "Когда [ситуация], я хочу [мотивация], чтобы [результат]"'>
            <TextareaInput v-model="ajtbdJob" :rows="2" placeholder="Провести 15-минутное CustDev-интервью с автором канала." />
          </Field>
          <Field label="When (триггер / ситуация)" style="grid-column: 1 / -1;">
            <TextareaInput v-model="ajtbdWhen" :rows="2" placeholder="Когда автор начинает получать первые входящие от рекламодателей." />
          </Field>
          <Field label="Desired outcome (как выглядит успех)" style="grid-column: 1 / -1;">
            <TextareaInput v-model="ajtbdDesiredOutcome" :rows="2" placeholder="Согласие на интервью + договорённость о времени." />
          </Field>
          <Field label="Push (что выталкивает)">
            <TagInput v-model="ajtbdPush" placeholder="Push-сила и Enter" />
          </Field>
          <Field label="Pull (к чему тянет)">
            <TagInput v-model="ajtbdPull" placeholder="Pull-сила и Enter" />
          </Field>
          <Field label="Anxieties (опасения)">
            <TagInput v-model="ajtbdAnxieties" placeholder="Опасение и Enter" />
          </Field>
          <Field label="Habits (текущая привычка)">
            <TagInput v-model="ajtbdHabits" placeholder="Привычка и Enter" />
          </Field>
          <Field label="Non-goals (anti-цели — не CustDev)" style="grid-column: 1 / -1;" help="Если разговор сваливается сюда, GoalFitEvaluator незаметно передаёт оператору.">
            <TagInput v-model="ajtbdNonGoals" placeholder="Anti-цель и Enter" />
          </Field>
        </div>
      </div>
    </div>

    <!-- ─── Agency goal (agency_sourcing) ─── -->
    <div v-if="typesAvailable && selectedTypeKey === 'agency_sourcing'" class="card" style="margin-top: 12px;">
      <div class="card-head">
        <Icon name="flag" :size="12" />
        <span>Цель агентского сбора</span>
        <span class="muted-2" style="margin-left: 6px;">какие данные собрать у блогеров</span>
      </div>
      <div class="card-body">
        <AgencyGoalEditor
          v-model:target-data-points="agencyTargetDataPoints"
          v-model:client-brief="agencyClientBrief"
        />
      </div>
    </div>

    <!-- ─── Generic goal editor (other types) ─── -->
    <div
      v-else-if="typesAvailable && selectedTypeKey !== 'custdev'"
      class="card"
      style="margin-top: 12px;"
    >
      <div class="card-head"><Icon name="list" :size="12" /><span>Цель (JSON по goal-схеме типа)</span></div>
      <div class="card-body">
        <Field
          label="goal"
          :error="goalJsonError"
          help="Поля валидируются на сервере против goalSchema выбранного типа."
        >
          <TextareaInput v-model="goalJson" :rows="6" mono :error="!!goalJsonError" />
        </Field>
      </div>
    </div>

    <!-- ─── Аудитория ─── -->
    <div class="card" style="margin-top: 12px;">
      <div class="card-head"><Icon name="filter" :size="12" /><span>Аудитория (target filter)</span></div>
      <div class="card-body">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <Field label="Платформы"><MultiToggle v-model="filterPlatforms" :options="PLATFORMS" tone="accent" /></Field>
          <Field label="Роль контакта"><MultiToggle v-model="filterRoles" :options="ROLES" tone="ok" /></Field>
          <Field label="Языки канала"><MultiToggle v-model="filterLanguages" :options="LANGS" /></Field>
          <Field label="Минимальная уверенность"><SelectInput v-model="filterMinConfidence" :options="MIN_CONF" /></Field>
          <Field label="Тематики (свободные слова)" style="grid-column: 1 / -1;" help="Например: B2B, dev tools, edtech. Enter — добавить.">
            <TagInput v-model="filterTopics" placeholder="Тема канала и Enter" />
          </Field>
          <Field label="Тэги контактов" style="grid-column: 1 / -1;" help="Так же фильтруются вручную добавленные контакты (cmp:&lt;id&gt; добавляется автоматически).">
            <TagInput v-model="filterTags" placeholder="Тэг и Enter" />
          </Field>
        </div>
      </div>
    </div>

    <!-- ─── Расписание ─── -->
    <div class="card" style="margin-top: 12px;">
      <div class="card-head"><Icon name="clock" :size="12" /><span>Расписание отправки</span></div>
      <div class="card-body">
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 12px;">
          <Field label="Часовой пояс"><SelectInput v-model="scheduleTz" :options="TIMEZONES" /></Field>
          <Field label="Старт окна">
            <input class="input" type="time" v-model="scheduleStart" />
          </Field>
          <Field label="Конец окна">
            <input class="input" type="time" v-model="scheduleEnd" />
          </Field>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 220px; gap: 16px; align-items: start;">
          <Field label="Дни недели"><MultiToggle v-model="scheduleDays" :options="DAYS" tone="accent" /></Field>
          <Field label="Макс. сообщений / день / аккаунт">
            <input
              class="input"
              type="number"
              min="1"
              max="200"
              :value="scheduleMaxPerDay"
              @input="scheduleMaxPerDay = Number(($event.target as HTMLInputElement).value) || 0"
            />
          </Field>
        </div>
      </div>
    </div>

    <!-- ─── Outreach пул ─── -->
    <div class="card" style="margin-top: 12px;">
      <div class="card-head">
        <Icon name="send" :size="12" />
        <span>Outreach аккаунты (пул)</span>
        <span class="muted-2" style="margin-left: 6px;">{{ outreachAccountPool.length }} выбрано</span>
      </div>
      <div class="card-body">
        <div v-if="outreachAccounts.length === 0" class="placeholder" style="min-height: 60px;">
          Нет outreach-аккаунтов. Добавьте на странице «TG-аккаунты».
        </div>
        <div v-else style="display: flex; flex-wrap: wrap; gap: 6px;">
          <button
            v-for="a in outreachAccounts"
            :key="a.id"
            type="button"
            :class="['chip', outreachAccountPool.includes(a.id) ? 'applied accent' : '']"
            @click="togglePoolAccount(a.id)"
          >
            <Icon v-if="outreachAccountPool.includes(a.id)" name="check" :size="10" :stroke="2.4" />
            <span>{{ a.label }}</span>
            <span class="muted-2">·</span>
            <span class="mono" style="font-size: 10px;">{{ a.phone }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ─── Advanced ─── -->
    <div class="card" style="margin-top: 12px;">
      <button
        type="button"
        class="card-head"
        style="background: var(--paper-2); cursor: pointer; width: 100%; border: none; border-bottom: 1px solid var(--line);"
        @click="advancedOpen = !advancedOpen"
      >
        <Icon name="sliders" :size="12" /><span>Расширенные настройки (agent overrides)</span>
        <div class="actions">
          <Icon :name="advancedOpen ? 'chev_down' : 'chev_right'" :size="12" />
        </div>
      </button>
      <div v-if="advancedOpen" class="card-body">
        <Field label="Override параметров агентов (JSON)" :error="overridesError" help='Пример: {"reply_composer":{"params":{"temperature":0.4}}}'>
          <TextareaInput v-model="overridesJson" :rows="8" mono :error="!!overridesError" />
        </Field>
      </div>
    </div>

    <template #footer>
      <button class="btn" :disabled="mut.isPending.value" @click="emit('close')">Отмена</button>
      <button class="btn primary" :disabled="mut.isPending.value || !canSubmit" @click="mut.mutate()">
        <span v-if="mut.isPending.value" class="spinner" />
        <span>Сохранить</span>
      </button>
    </template>
  </Modal>
</template>
