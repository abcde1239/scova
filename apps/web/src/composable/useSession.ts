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

    function restore(background = false): Promise<void> {
        if (restoration) return restoration;
        if (!background) phase.value = 'recovering';
        const scope = lifecycle.capture();
        restoration = (async () => {
            try {
                const response = await scope.request(currentSessionEndpoint, {});
                if (background) scope.refreshSession(response.data);
                else scope.replaceSession(response.data);
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
        ['login', 'register', 'not-found', 'service-unavailable'].includes(String(route.name)) ||
        (import.meta.env.MODE === 'test' && route.path.startsWith('/__examples/'))
    );
}

/** 只接受已登记的站内目标；服务恢复可返回认证页，登录成功仍排除认证页。 */
export function sessionReturnTarget(router: Router, value: unknown, allowAuth = false): string {
    if (typeof value !== 'string' || !value.startsWith('/') || /[\\\s]/.test(value)) return '/';
    try {
        const decoded = decodeURIComponent(value);
        if (
            decoded.startsWith('//') ||
            decoded.includes('\\') ||
            Array.from(decoded).some((character) => character.charCodeAt(0) <= 32)
        )
            return '/';
        const url = new URL(value, 'https://scova.invalid');
        if (url.origin !== 'https://scova.invalid') return '/';
        const target = router.resolve(value);
        return target.matched.length &&
            (!isPublicPage(target) ||
                (allowAuth && ['login', 'register'].includes(String(target.name))))
            ? target.fullPath
            : '/';
    } catch {
        return '/';
    }
}

export function installSessionRouting(router: Router, session: SessionController) {
    let checkedEpoch: number | undefined;
    let checkingNavigation = 0;
    const loginLocation = (path: string) => ({
        name: 'login',
        query: { redirect: sessionReturnTarget(router, path) },
        replace: true,
    });
    const removeGuard = router.beforeEach(async (to) => {
        if (to.name === 'service-unavailable') return true;
        checkingNavigation++;
        try {
            const restoring = session.phase.value !== 'ready';
            await session.ensure();
            // 登录响应与首次恢复已确认身份；后续业务导航在提交路由前重新核验。
            if (
                !restoring &&
                !isPublicPage(to) &&
                session.user.value &&
                session.phase.value === 'ready' &&
                checkedEpoch === session.lifecycle.session.epoch
            )
                await session.restore(true);
            checkedEpoch = session.lifecycle.session.epoch;
            if (session.phase.value === 'unavailable')
                return {
                    name: 'service-unavailable',
                    query: { redirect: sessionReturnTarget(router, to.fullPath, true) },
                    replace: true,
                };
            if (isPublicPage(to) || session.user.value) return true;
            return loginLocation(to.fullPath);
        } finally {
            checkingNavigation--;
        }
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
            // 在途导航由守卫保留目的地址，避免观察器用旧页面抢先重定向。
            if (checkingNavigation) return;
            if (
                session.phase.value === 'unavailable' &&
                router.currentRoute.value.matched.length &&
                router.currentRoute.value.name !== 'service-unavailable'
            ) {
                void router.replace({
                    name: 'service-unavailable',
                    query: {
                        redirect: sessionReturnTarget(
                            router,
                            router.currentRoute.value.fullPath,
                            true,
                        ),
                    },
                });
            } else if (
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
