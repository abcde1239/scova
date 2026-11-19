import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import '@/main.css';
import 'virtual:uno.css';
import App from '@/App.vue';
import { createSessionLifecycle, sessionLifecycleKey } from '@/api/session';
import { createInterfaceI18n } from '@/utils/i18n';
import { createWorkbenchRouter } from '@/router';
import {
    createSessionController,
    installSessionRouting,
    sessionControllerKey,
} from '@/composable/useSession';

export async function mountApplication() {
    const router = createWorkbenchRouter();
    const lifecycle = createSessionLifecycle();
    const session = createSessionController(lifecycle);
    const disposeRouting = installSessionRouting(router, session);
    const app = createApp(App)
        .use(lifecycle.pinia)
        .use(createInterfaceI18n())
        .use(VueQueryPlugin, { queryClient: lifecycle.queryClient })
        .provide(sessionLifecycleKey, lifecycle)
        .provide(sessionControllerKey, session)
        .use(router);
    const dispose = () => {
        disposeRouting();
        app.unmount();
        lifecycle.dispose();
    };
    try {
        // Mount immediately: the existing session loading state stays visible during navigation.
        app.mount('#app');
        await router.isReady();
    } catch (error) {
        dispose();
        throw error;
    }

    if (import.meta.hot) import.meta.hot.dispose(dispose);
}
