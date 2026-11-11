import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import '@/main.css';
import 'virtual:uno.css';
import App from '@/App.vue';
import { createSessionLifecycle, sessionLifecycleKey } from '@/api/session';
import { createWorkbenchRouter } from '@/router';
import {
    createSessionController,
    installSessionRouting,
    sessionControllerKey,
} from '@/composables/useSession';

const router = createWorkbenchRouter();
const lifecycle = createSessionLifecycle();
const session = createSessionController(lifecycle);
const disposeRouting = installSessionRouting(router, session);
const app = createApp(App)
    .use(lifecycle.pinia)
    .use(VueQueryPlugin, { queryClient: lifecycle.queryClient })
    .provide(sessionLifecycleKey, lifecycle)
    .provide(sessionControllerKey, session)
    .use(router);
app.mount('#app');

if (import.meta.hot)
    import.meta.hot.dispose(() => {
        disposeRouting();
        lifecycle.dispose();
    });
