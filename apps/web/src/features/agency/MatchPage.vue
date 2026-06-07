<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import PageHead from '../../components/PageHead.vue';
import Icon from '../../components/Icon.vue';
import Field from '../../components/Field.vue';
import TextInput from '../../components/TextInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import TagInput from '../../components/TagInput.vue';
import Switch from '../../components/Switch.vue';
import Pill from '../../components/Pill.vue';
import Tag from '../../components/Tag.vue';
import ConfBar from '../../components/ConfBar.vue';
import EmptyState from '../../components/EmptyState.vue';
import FeatureOff from '../../components/FeatureOff.vue';
import { api } from '../../lib/api';
import { isFeatureOff } from '../../lib/featureGate';
import { toast } from '../../lib/toast';
import { formatCompact } from '../../lib/format';
import type { AdBrief, BloggerPostInsight, CreateAdBriefInput, MatchResponse } from './types';

const router = useRouter();

// ─── Brief form ───
const topic = ref('');
const audienceTarget = ref('');
const budget = ref<string>('');
const formats = ref<string[]>([]);
const geo = ref<string[]>([]);
const deadline = ref('');
const notes = ref('');
const rerank = ref(false);

const result = ref<MatchResponse | null>(null);
const featureOff = ref(false);

const canSubmit = computed(() => topic.value.trim().length > 0);

const mut = useMutation({
  mutationFn: async () => {
    const brief: CreateAdBriefInput = {
      topic: topic.value.trim(),
      audienceTarget: audienceTarget.value.trim(),
      formats: formats.value,
      geo: geo.value,
      notes: notes.value.trim(),
      ...(budget.value ? { budget: Number(budget.value) } : {}),
      ...(deadline.value ? { deadline: new Date(deadline.value).toISOString() } : {}),
    };
    // Persist the brief, then match it. Two calls per the API contract:
    // POST /ad-briefs → POST /ad-briefs/:id/match.
    const created = await api.post<AdBrief>('/ad-briefs', brief);
    return api.post<MatchResponse>(
      `/ad-briefs/${created.id}/match`,
      { rerank: rerank.value },
    );
  },
  onSuccess: (r) => {
    result.value = r;
    toast.success(`Найдено кандидатов: ${r.candidates.length}`);
  },
  onError: (e) => {
    if (isFeatureOff(e)) {
      featureOff.value = true;
      return;
    }
    toast.error('Матчинг не выполнен', (e as Error).message);
  },
});

const candidates = computed(() => result.value?.candidates ?? []);

function profileName(profile: MatchResponse['candidates'][number]['profile']): string {
  return profile.displayName || profile.channelId || profile.id.slice(0, 8);
}

function evidencePosts(c: MatchResponse['candidates'][number]): BloggerPostInsight[] {
  const ids = new Set(c.fit?.evidencePostIds ?? []);
  return (c.profile.topPostsPreview ?? []).filter((post) => ids.has(post.id));
}

function metricLabel(post: BloggerPostInsight): string {
  const m = post.metrics;
  return [
    m.views != null ? `${formatCompact(m.views)} views` : '',
    m.likes != null ? `${formatCompact(m.likes)} likes` : '',
    m.reactions != null ? `${formatCompact(m.reactions)} react` : '',
  ].filter(Boolean).join(' · ') || 'метрик нет';
}
</script>

<template>
  <PageHead title="Подбор блогеров" sub="Бриф рекламодателя → ранжированные кандидаты из базы" />

  <FeatureOff v-if="featureOff" flag="ENABLE_BLOGGER_MATCHING" />

  <div v-else style="display: grid; grid-template-columns: 380px 1fr; gap: 16px; align-items: start;">
    <!-- Brief form -->
    <div class="card">
      <div class="card-head"><Icon name="flag" :size="12" /><span>Бриф</span></div>
      <div class="card-body">
        <Field label="Тема / ниша" help="Обязательное поле.">
          <TextInput v-model="topic" placeholder="например: финтех, личные финансы" />
        </Field>
        <Field label="Целевая аудитория">
          <TextInput v-model="audienceTarget" placeholder="например: 25–40, РФ, инвесторы" />
        </Field>
        <Field label="Бюджет (за размещение)">
          <TextInput v-model="budget" type="number" placeholder="50000" />
        </Field>
        <Field label="Форматы">
          <TagInput v-model="formats" placeholder="пост / сторис / reels и Enter" />
        </Field>
        <Field label="Гео">
          <TagInput v-model="geo" placeholder="RU / KZ и Enter" />
        </Field>
        <Field label="Дедлайн">
          <input class="input" type="date" v-model="deadline" />
        </Field>
        <Field label="Заметки">
          <TextareaInput v-model="notes" :rows="3" placeholder="Дополнительные требования к размещению" />
        </Field>
        <Field label="LLM re-rank" help="По умолчанию выключено — детерминированное ранжирование. Включите для уточнения топ-N через модель.">
          <div style="display: flex; align-items: center; gap: 8px;">
            <Switch v-model="rerank" />
            <span class="muted" style="font-size: 12px;">{{ rerank ? 'включено' : 'выключено' }}</span>
          </div>
        </Field>

        <button
          class="btn primary"
          style="width: 100%; margin-top: 8px;"
          :disabled="mut.isPending.value || !canSubmit"
          @click="mut.mutate()"
        >
          <span v-if="mut.isPending.value" class="spinner" />
          <Icon v-else name="search" :size="12" />
          <span>Подобрать</span>
        </button>
      </div>
    </div>

    <!-- Results -->
    <div>
      <EmptyState
        v-if="!result && !mut.isPending.value"
        title="Заполните бриф"
        description="Укажите тему и параметры — система отранжирует подходящих блогеров из базы."
        icon="search"
      />
      <div v-else-if="result && candidates.length === 0" class="card">
        <div class="card-body">
          <EmptyState title="Кандидатов не найдено" description="Под указанные параметры в базе нет подходящих профилей." icon="users_round" />
        </div>
      </div>
      <div v-else class="cards" style="grid-template-columns: 1fr;">
        <div v-for="(c, i) in candidates" :key="c.profile.id" class="card">
          <div class="card-head" style="cursor: pointer;" @click="router.push(`/bloggers/${c.profile.id}`)">
            <span class="mono muted-2">#{{ i + 1 }}</span>
            <span style="font-weight: 500; flex: 1;">{{ profileName(c.profile) }}</span>
            <Pill v-if="c.rerankedByLlm" cls="violet" :dot="false" label="LLM re-rank" />
            <span class="mono cell-strong" style="font-size: 14px;">{{ Math.round(c.score * 100) }}</span>
          </div>
          <div class="card-body">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
              <ConfBar :value="c.score" />
              <span class="muted-2" style="font-size: 11px;">score</span>
            </div>
            <p class="muted" style="font-size: 12.5px; line-height: 1.5; margin: 0 0 10px;">{{ c.rationale || '—' }}</p>
            <div v-if="c.fit?.positiveSignals.length || c.fit?.gaps.length" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
              <div>
                <div class="muted-2" style="font-size: 10.5px; text-transform: uppercase; margin-bottom: 4px;">Сигналы</div>
                <div v-if="c.fit?.positiveSignals.length" style="display: flex; flex-wrap: wrap; gap: 4px;">
                  <Tag v-for="s in c.fit.positiveSignals.slice(0, 4)" :key="s">{{ s }}</Tag>
                </div>
                <span v-else class="muted-2" style="font-size: 12px;">—</span>
              </div>
              <div>
                <div class="muted-2" style="font-size: 10.5px; text-transform: uppercase; margin-bottom: 4px;">Гэпы</div>
                <div v-if="c.fit?.gaps.length" style="display: flex; flex-wrap: wrap; gap: 4px;">
                  <Tag v-for="g in c.fit.gaps.slice(0, 4)" :key="g">{{ g }}</Tag>
                </div>
                <span v-else class="muted-2" style="font-size: 12px;">—</span>
              </div>
            </div>
            <div v-if="evidencePosts(c).length" style="margin-bottom: 10px; display: grid; gap: 6px;">
              <div class="muted-2" style="font-size: 10.5px; text-transform: uppercase;">Посты-доказательства</div>
              <div
                v-for="post in evidencePosts(c)"
                :key="post.id"
                style="border: 1px solid var(--line); border-radius: 8px; padding: 8px;"
              >
                <div style="display: flex; justify-content: space-between; gap: 8px;">
                  <span class="mono cell-strong" style="font-size: 11.5px;">{{ metricLabel(post) }}</span>
                  <a v-if="post.url" :href="post.url" target="_blank" rel="noreferrer" class="muted-2" style="font-size: 11px;">post</a>
                </div>
                <div class="muted" style="font-size: 12px; margin-top: 4px;">{{ post.textSnippet }}</div>
              </div>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px;">
              <Tag v-for="t in c.profile.topics.slice(0, 5)" :key="t">{{ t }}</Tag>
            </div>
            <div class="muted-2" style="font-size: 11px;">
              охват {{ c.profile.reach != null ? formatCompact(c.profile.reach) : '—' }} ·
              ср. просмотры {{ c.profile.avgViews != null ? formatCompact(c.profile.avgViews) : '—' }} ·
              форматы {{ c.profile.formats.join(', ') || '—' }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
