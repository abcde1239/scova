import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import 'virtual:uno.css';
import App from '@/App.vue';
import { createSessionLifecycle, sessionLifecycleKey } from '@/api/session';
import '@/style.css';
import { createWorkbenchRouter } from '@/router';

const router = createWorkbenchRouter();
const lifecycle = createSessionLifecycle();
const app = createApp(App)
    .use(lifecycle.pinia)
    .use(VueQueryPlugin, { queryClient: lifecycle.queryClient })
    .provide(sessionLifecycleKey, lifecycle)
    .use(router);
void router.isReady().then(() => app.mount('#app'));

if (import.meta.hot) import.meta.hot.dispose(() => lifecycle.dispose());
