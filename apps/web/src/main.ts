import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import 'virtual:uno.css';
import App from '@/App.vue';
import { createSessionLifecycle, sessionLifecycleKey } from '@/api/session';
import '@/style.css';

const lifecycle = createSessionLifecycle();
createApp(App)
    .use(lifecycle.pinia)
    .use(VueQueryPlugin, { queryClient: lifecycle.queryClient })
    .provide(sessionLifecycleKey, lifecycle)
    .mount('#app');

if (import.meta.hot) import.meta.hot.dispose(() => lifecycle.dispose());
