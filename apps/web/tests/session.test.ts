import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import {
    createSessionController,
    installSessionRouting,
    sessionReturnTarget,
} from '@/composables/useSession';

const account: SessionResponse = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'a@example.org',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'sample-csrf',
};
const active: (() => void)[] = [];
function errorResponse(status: number) {
    return Response.json(
        { code: 'TEST_ERROR', message: 'sample', requestId: 'sample' },
        { status },
    );
}
function setup(fetcher: typeof fetch = async () => Response.json(account)) {
    const lifecycle = createSessionLifecycle({ fetcher });
    const session = createSessionController(lifecycle);
    const router = createRouter({
        history: createMemoryHistory(),
        routes: ['tasks', 'library', 'login', 'register', 'service-unavailable']
            .map((name) => ({
                path: `/${name}`,
                name,
                component: { render: () => null },
            }))
            .concat([
                { path: '/:pathMatch(.*)*', name: 'not-found', component: { render: () => null } },
            ]),
    });
    const disposeRouting = installSessionRouting(router, session);
    active.push(() => {
        disposeRouting();
        lifecycle.dispose();
    });
    return { lifecycle, session, router };
}
afterEach(() => active.splice(0).forEach((dispose) => dispose()));

describe('session recovery and navigation', () => {
    it('deduplicates initial recovery and waits before granting a direct protected route', async () => {
        let complete!: (value: Response) => void;
        const fetcher = vi.fn<typeof fetch>().mockImplementation(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const { session, router } = setup(fetcher);
        const navigation = router.push('/library?filter=all#section');
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        expect(session.phase.value).toBe('recovering');
        const overlap = session.ensure();
        complete(Response.json(account));
        await Promise.all([navigation, overlap]);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(router.currentRoute.value.fullPath).toBe('/library?filter=all#section');
        expect(session.user.value?.id).toBe(account.user.id);
    });
    it('takes 401 to login with a local return target and does not loop on auth pages', async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => errorResponse(401));
        const { session, router } = setup(fetcher);
        await router.push('/library?filter=all#section');
        expect(session.phase.value).toBe('ready');
        expect(router.currentRoute.value.name).toBe('login');
        expect(router.currentRoute.value.query.redirect).toBe('/library?filter=all#section');
        await router.push('/register');
        expect(router.currentRoute.value.name).toBe('register');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('keeps an existing account on temporary failure and allows explicit retry', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json(account))
            .mockResolvedValueOnce(errorResponse(503))
            .mockResolvedValueOnce(Response.json(account));
        const { session, router } = setup(fetcher);
        await router.push('/library');
        await session.restore();
        expect(session.phase.value).toBe('unavailable');
        expect(session.user.value?.id).toBe(account.user.id);
        await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('service-unavailable'));
        expect(router.currentRoute.value.query.redirect).toBe('/library');
        await session.restore();
        await router.replace('/library');
        expect(session.phase.value).toBe('ready');
        expect(router.currentRoute.value.name).toBe('library');
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it.each(['/library?filter=all#section', '/login?redirect=/library', '/register'])(
        'routes unavailable startup %s to a standalone error with a safe retry target',
        async (path) => {
            const { session, router } = setup(async () => {
                throw new TypeError('offline');
            });
            await router.push(path);
            expect(session.phase.value).toBe('unavailable');
            expect(router.currentRoute.value.name).toBe('service-unavailable');
            expect(router.currentRoute.value.query.redirect).toBe(path);
        },
    );
    it('after service recovery a 401 goes to login without mounting the original route', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(errorResponse(503))
            .mockResolvedValueOnce(errorResponse(401));
        const { session, router } = setup(fetcher);
        await router.push('/library?filter=all#section');
        expect(router.currentRoute.value.name).toBe('service-unavailable');
        const target = sessionReturnTarget(router, router.currentRoute.value.query.redirect, true);
        await session.restore();
        await router.replace(target);
        expect(router.currentRoute.value.name).toBe('login');
        expect(router.currentRoute.value.query.redirect).toBe('/library?filter=all#section');
    });
    it('never retries to the service error itself or an external URL', () => {
        const { router } = setup();
        for (const value of [
            '/service-unavailable?redirect=/library',
            '//evil.example',
            '/unknown',
        ])
            expect(sessionReturnTarget(router, value, true)).toBe('/tasks');
        expect(sessionReturnTarget(router, '/login?redirect=/library', true)).toBe(
            '/login?redirect=/library',
        );
    });
    it('ignores a recovery result superseded by another login', async () => {
        let complete!: (value: Response) => void;
        const { lifecycle, session } = setup(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const recovery = session.restore();
        await vi.waitFor(() => expect(complete).toBeDefined());
        const next = {
            ...account,
            user: { ...account.user, id: '00000000-0000-4000-8000-000000000002' },
        };
        lifecycle.replaceSession(next);
        complete(errorResponse(401));
        await recovery;
        expect(session.user.value?.id).toBe(next.user.id);
        expect(session.phase.value).toBe('ready');
    });
    it('checks a later protected navigation before committing it and preserves same-session cache', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockImplementation(async () => Response.json(account));
        const { lifecycle, session, router } = setup(fetcher);
        await router.push('/library');
        const epoch = lifecycle.session.epoch;
        const cleanup = vi.fn();
        lifecycle.capture().registerCleanup(cleanup);
        lifecycle.queryClient.setQueryData(['keep-cache'], 'saved');
        await router.push('/tasks');
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(lifecycle.session.epoch).toBe(epoch);
        expect(lifecycle.queryClient.getQueryData(['keep-cache'])).toBe('saved');
        expect(cleanup).not.toHaveBeenCalled();
        fetcher.mockRejectedValueOnce(new TypeError('offline'));
        await router.push('/library?filter=all#section');
        expect(session.phase.value).toBe('unavailable');
        expect(router.currentRoute.value.name).toBe('service-unavailable');
        expect(router.currentRoute.value.query.redirect).toBe('/library?filter=all#section');
    });
    it('handles an expired session before committing a later protected navigation', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json(account))
            .mockResolvedValueOnce(errorResponse(401));
        const { session, router } = setup(fetcher);
        await router.push('/library');
        await router.push('/tasks');
        expect(session.user.value).toBeNull();
        expect(router.currentRoute.value.name).toBe('login');
        expect(router.currentRoute.value.query.redirect).toBe('/tasks');
    });
    it.each(['account', 'csrf'])(
        'invalidates the previous scope when revalidation changes %s',
        async (change) => {
            const { lifecycle, router } = setup();
            await router.push('/library');
            const scope = lifecycle.capture();
            const cleanup = vi.fn();
            scope.registerCleanup(cleanup);
            lifecycle.queryClient.setQueryData(['private'], 'old');
            scope.refreshSession({
                ...account,
                user:
                    change === 'account'
                        ? { ...account.user, id: '00000000-0000-4000-8000-000000000002' }
                        : account.user,
                csrfToken: change === 'csrf' ? 'replacement-csrf' : account.csrfToken,
            });
            expect(scope.isCurrent()).toBe(false);
            expect(cleanup).toHaveBeenCalledTimes(1);
            expect(lifecycle.queryClient.getQueryData(['private'])).toBeUndefined();
        },
    );
    it('locks logout, sends in-memory CSRF and clears all account cache on success', async () => {
        let complete!: (value: Response) => void;
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json(account))
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        complete = resolve;
                    }),
            );
        const { lifecycle, session, router } = setup(fetcher);
        await router.push('/library');
        lifecycle.queryClient.setQueryData(['account-private'], { private: true });
        const first = session.logout();
        await session.logout();
        expect(session.logoutPending.value).toBe(true);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('x-csrf-token')).toBe(
            account.csrfToken,
        );
        complete(new Response(null, { status: 204 }));
        await first;
        await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
        expect(session.user.value).toBeNull();
        expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(0);
        expect(session.logoutPending.value).toBe(false);
        expect(session.logoutError.value).toBe('');
        await router.push('/library');
        expect(router.currentRoute.value.name).toBe('login');
    });
    it('preserves account and reports failed logout, allowing retry', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json(account))
            .mockRejectedValueOnce(new TypeError('offline'))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const { session, router } = setup(fetcher);
        await router.push('/tasks');
        await session.logout();
        expect(session.user.value?.id).toBe(account.user.id);
        expect(session.logoutError.value).toContain('退出未成功');
        await session.logout();
        expect(session.user.value).toBeNull();
        expect(session.logoutError.value).toBe('');
    });
    it('redirects a current expired account and ignores an old late 401', async () => {
        let complete!: (value: Response) => void;
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json(account))
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        complete = resolve;
                    }),
            )
            .mockResolvedValueOnce(errorResponse(401));
        const { lifecycle, session, router } = setup(fetcher);
        await router.push('/library');
        const oldLogout = session.logout();
        await vi.waitFor(() => expect(complete).toBeDefined());
        const next = {
            ...account,
            user: { ...account.user, id: '00000000-0000-4000-8000-000000000002' },
        };
        lifecycle.replaceSession(next);
        complete(errorResponse(401));
        await oldLogout;
        await nextTick();
        expect(session.user.value?.id).toBe(next.user.id);
        expect(router.currentRoute.value.name).toBe('library');
        await session.logout();
        await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
        expect(session.user.value).toBeNull();
        expect(session.logoutError.value).toBe('会话已过期，请重新登录');
    });
    it.each([
        'https://evil.example',
        '//evil.example',
        '/\\evil.example',
        '/%5cevil.example',
        '/%2f%2fevil.example',
        '/login?redirect=/tasks',
        '/register',
        '/unknown',
        '/%zz',
        ['//evil.example'],
        undefined,
    ])('rejects unsafe, unknown or recursive return target %s', (value) => {
        const { router } = setup();
        expect(sessionReturnTarget(router, value)).toBe('/tasks');
    });
    it('retains a valid local target including query and fragment', () => {
        const { router } = setup();
        expect(sessionReturnTarget(router, '/library?filter=all#section')).toBe(
            '/library?filter=all#section',
        );
    });
});
