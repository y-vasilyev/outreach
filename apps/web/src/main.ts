import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import { router } from './router';
import { queryClient } from './lib/queryClient';
import { bootstrapAuth } from './lib/auth';
import { installChunkReloadHandler } from './lib/chunkReload';
import './styles.css';

// Recover stale tabs after a redeploy: reload once when a lazy chunk fails to
// load. The router clears the sentinel only after a successful navigation, so
// a persistently missing chunk cannot enter a reload loop.
installChunkReloadHandler();

bootstrapAuth();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(VueQueryPlugin, { queryClient });

app.mount('#root');
