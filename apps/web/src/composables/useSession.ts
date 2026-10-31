import { computed, inject, ref, watch, type InjectionKey } from 'vue';
import type { Router } from 'vue-router';
import type { SessionLifecycle } from '@/api/session';
import { currentSessionEndpoint, logoutEndpoint } from '@/api/endpoints';
import { toApiError } from '@/api/errors';

/** 页面状态不保存凭据；会话、缓存及流清理由既有生命周期统一管理。 */
export function createSessionController(lifecycle: SessionLifecycle) {
    const phase = ref<'initial' | 'recovering' | 'ready' | 'unavailable'>('initial');
    const logoutPending = ref(false);
    const logoutError = ref('');
    let restoration: Promise<void> | undefined;
    let loggedOutEpoch: number | undefined;

    function restore(): Promise<void> {
        if (restoration) return restoration;
        phase.value = 'recovering';
        const scope = lifecycle.capture();
        restoration = (async () => {
            try {
                const response = await scope.request(currentSessionEndpoint, {});
                scope.replaceSession(response.data);
                phase.value = 'ready';
            } catch (cause) {
                const error = toApiError(cause);
                // 旧代次取消不能把刚登录的新账号变成暂不可达。
                phase.value =
                    error.status === 401 || error.kind === 'cancelled' ? 'ready' : 'unavailable';
            } finally {
                restoration = undefined;
            }
        })();
        return restoration;
    }

    async function ensure() {
        if (phase.value === 'initial' || phase.value === 'recovering') await restore();
    }

    async function logout() {
        if (logoutPending.value || !lifecycle.session.user) return;
        logoutPending.value = true;
        logoutError.value = '';
        const scope = lifecycle.capture();
        try {
            await scope.request(logoutEndpoint, {});
            scope.replaceSession(null);
            loggedOutEpoch = lifecycle.session.epoch;
            phase.value = 'ready';
        } catch (cause) {
            const error = toApiError(cause);
            if (error.kind !== 'cancelled')
                logoutError.value =
                    error.status === 401
                        ? '会话已过期，请重新登录'
                        : '退出未成功，请检查连接后重试';
        } finally {
            logoutPending.value = false;
        }
    }

    return {
        lifecycle,
        phase,
        user: computed(() => lifecycle.session.user),
        logoutPending,
        logoutError,
        wasLoggedOut: (epoch: number) => epoch === loggedOutEpoch,
        restore,
        ensure,
        logout,
    };
}

export type SessionController = ReturnType<typeof createSessionController>;
export const sessionControllerKey: InjectionKey<SessionController> = Symbol('session-controller');

export function useSession() {
    const session = inject(sessionControllerKey);
    if (!session) throw new Error('尚未安装会话恢复');
    return session;
}

export function isPublicPage(route: { name?: string | symbol | null; path: string }) {
    return (
        ['login', 'register', 'not-found'].includes(String(route.name)) ||
        (import.meta.env.MODE === 'test' && route.path.startsWith('/__examples/'))
    );
}

/** 只接受本路由器可识别的站内页面，认证页和未知页不作为返回目标。 */
export function sessionReturnTarget(router: Router, value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('/') || /[\\\s]/.test(value))
        return '/tasks';
    try {
        const decoded = decodeURIComponent(value);
        if (
            decoded.startsWith('//') ||
            decoded.includes('\\') ||
            Array.from(decoded).some((character) => character.charCodeAt(0) <= 32)
        )
            return '/tasks';
        const url = new URL(value, 'https://scova.invalid');
        if (url.origin !== 'https://scova.invalid') return '/tasks';
        const target = router.resolve(value);
        return target.matched.length && !isPublicPage(target) ? target.fullPath : '/tasks';
    } catch {
        return '/tasks';
    }
}

export function installSessionRouting(router: Router, session: SessionController) {
    const loginLocation = (path: string) => ({
        name: 'login',
        query: { redirect: sessionReturnTarget(router, path) },
        replace: true,
    });
    const removeGuard = router.beforeEach(async (to) => {
        await session.ensure();
        if (isPublicPage(to) || session.user.value || session.phase.value === 'unavailable')
            return true;
        return loginLocation(to.fullPath);
    });
    const stop = watch(
        () =>
            [session.lifecycle.session.epoch, session.phase.value, session.user.value?.id] as const,
        ([epoch, , accountId], [previousEpoch, , previousAccount]) => {
            if (epoch !== previousEpoch)
                session.logoutError.value =
                    previousAccount && !accountId && !session.wasLoggedOut(epoch)
                        ? '会话已过期，请重新登录'
                        : '';
            if (session.user.value && epoch !== previousEpoch) session.phase.value = 'ready';
            else if (
                !session.user.value &&
                session.phase.value === 'ready' &&
                router.currentRoute.value.matched.length &&
                !isPublicPage(router.currentRoute.value)
            )
                void router.replace(loginLocation(router.currentRoute.value.fullPath));
        },
        { flush: 'post' },
    );
    return () => {
        removeGuard();
        stop();
    };
}
