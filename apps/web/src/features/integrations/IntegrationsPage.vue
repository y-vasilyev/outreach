<script setup lang="ts">
import PageHead from '../../components/PageHead.vue';
import IntegrationCard from './IntegrationCard.vue';

const KINDS = [
  {
    key: 'scrapecreators',
    title: 'ScrapeCreators',
    description: 'REST API для скрейпа Instagram и YouTube. Используется адаптерами IG/YT.',
  },
] as const;
</script>

<template>
  <PageHead title="Интеграции" sub="Внешние API для скрейпа и обогащения данных. Ключи хранятся зашифрованными." />
  <div class="cards" style="grid-template-columns: 1fr;">
    <IntegrationCard v-for="k in KINDS" :key="k.key" :kind="k.key" :title="k.title" :description="k.description" />
  </div>
</template>
