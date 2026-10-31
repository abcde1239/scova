import { createApp } from 'vue';
import { createPinia } from 'pinia';
import 'virtual:uno.css';
import App from '@/App.vue';
import '@/style.css';
import { createWorkbenchRouter } from '@/router';

const router = createWorkbenchRouter();
const app = createApp(App).use(createPinia()).use(router);
void router.isReady().then(() => app.mount('#app'));
