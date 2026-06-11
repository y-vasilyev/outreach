<script setup lang="ts">
import { computed } from 'vue';
import Avatar from '../../components/Avatar.vue';
import Icon from '../../components/Icon.vue';
import Tag from '../../components/Tag.vue';
import { bloggerDisplayTitle, bloggerPlatformLinks, type BloggerPlatformLink } from './blogger-display';
import type { BloggerProfile } from './types';

// Decision-ux header: «кто это» за секунды — имя, платформы-ссылки, темы,
// форматы, языки. Никаких внутренних идентификаторов (они в аудит-секции).
const props = defineProps<{ profile: BloggerProfile }>();

const title = computed(() => bloggerDisplayTitle(props.profile));
const links = computed(() => bloggerPlatformLinks(props.profile));
const channelUrl = computed(() => props.profile.channel?.url ?? null);
const channelHandle = computed(() => props.profile.channel?.handle ?? null);

function linkLabel(link: BloggerPlatformLink): string {
  return `${link.platform}${link.handle ? ` @${link.handle}` : ''}`;
}
</script>

<template>
  <div class="card">
    <div class="card-body" style="display: flex; gap: 14px; align-items: flex-start;">
      <Avatar :text="title.replace(/^@/, '')" :seed="profile.id" size="xl" />
      <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 9px;">
        <div style="display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;">
          <h2 style="margin: 0; font-size: 19px; line-height: 1.2;">{{ title }}</h2>
          <a
            v-if="channelUrl && channelHandle"
            class="mono"
            style="font-size: 12.5px;"
            :href="channelUrl"
            target="_blank"
            rel="noreferrer"
          >@{{ channelHandle }}</a>
          <span v-else-if="channelHandle" class="mono muted-2" style="font-size: 12.5px;">@{{ channelHandle }}</span>
        </div>

        <!-- Все платформы блогера (мультиплатформенность — первоклассная ось):
             основная (привязанный канал) помечена и идёт первой. -->
        <div v-if="links.length" style="display: flex; flex-wrap: wrap; gap: 6px;">
          <template v-for="link in links" :key="link.platform">
            <a
              v-if="link.url"
              class="btn"
              style="height: 26px; padding: 0 9px; font-size: 12px;"
              :href="link.url"
              target="_blank"
              rel="noreferrer"
              :title="link.primary ? 'Основная платформа' : undefined"
            >
              <Icon name="arrow_up_right" :size="11" />
              <span :style="link.primary ? 'font-weight: 600;' : undefined">{{ linkLabel(link) }}</span>
            </a>
            <Tag v-else :platform="link.platform" :title="link.primary ? 'Основная платформа' : undefined">
              {{ linkLabel(link) }}
            </Tag>
          </template>
        </div>

        <div
          v-if="profile.topics.length || profile.formats.length || profile.languages.length"
          style="display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;"
        >
          <div v-if="profile.topics.length" style="display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline;">
            <span class="muted-2" style="font-size: 11px; text-transform: uppercase;">Темы</span>
            <Tag v-for="t in profile.topics" :key="t">{{ t }}</Tag>
          </div>
          <div v-if="profile.formats.length" style="display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline;">
            <span class="muted-2" style="font-size: 11px; text-transform: uppercase;">Форматы</span>
            <Tag v-for="f in profile.formats" :key="f">{{ f }}</Tag>
          </div>
          <div v-if="profile.languages.length" style="display: flex; gap: 4px; align-items: baseline;">
            <span class="muted-2" style="font-size: 11px; text-transform: uppercase;">Языки</span>
            <span style="font-size: 12.5px;">{{ profile.languages.join(', ') }}</span>
          </div>
        </div>

        <!-- Fit verdict slot (катализатор решения при контексте кампании/брифа). -->
        <slot />
      </div>
    </div>
  </div>
</template>
