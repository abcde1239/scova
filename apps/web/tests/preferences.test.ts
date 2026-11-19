import { deferred } from './support/deferred';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick } from 'vue';
import type { SessionResponse, UpdatePreferencesInput } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { currentSessionEndpoint } from '@/api/endpoints';
import { createPreferencesController } from '@/composable/usePreferences';
import { useSessionQuery } from '@/composable/useSessionQuery';

const account: SessionResponse = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'a@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'preferences-test-only',
};
const disposals: (() => void)[] = [];
function setup(fetcher: typeof fetch = async () => Response.json(account)) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const form = createPreferencesController(lifecycle);
    disposals.push(() => {
        form.dispose();
        lifecycle.dispose();
    });
    return { lifecycle, form };
}
function failure(status: number, fieldErrors?: { path: string; message: string }[]) {
    return Response.json(
        {
            code: 'TEST_FAILURE',
            message: 'sample',
            requestId: 'sample',
            ...(fieldErrors ? { fieldErrors } : {}),
        },
        { status },
    );
}
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

describe('account default preferences', () => {
    it('validates IANA timezones, minimum one field and notification enums before dispatch', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(account));
        const { form } = setup(fetcher);
        expect(await form.submit({})).toBe('invalid');
        expect(form.message.value).toContain('至少修改一项');
        expect(await form.submit({ defaultTimezone: 'Moon/Base' })).toBe('invalid');
        expect(form.firstField.value).toBe('defaultTimezone');
        expect(
            await form.submit({
                notificationPreference: { mode: 'email', runIssues: true },
            } as unknown as UpdatePreferencesInput),
        ).toBe('invalid');
        expect(form.firstField.value).toBe('mode');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('sends only changed fields with current CSRF, refreshes the summary and releases the old Query epoch', async () => {
        let current = account;
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === 'PATCH') {
                current = {
                    ...account,
                    user: {
                        ...account.user,
                        preferences: {
                            ...account.user.preferences,
                            defaultTimezone: 'Asia/Shanghai',
                        },
                    },
                };
            }
            return Response.json(current);
        });
        const { lifecycle, form } = setup(fetcher);
        const originalScope = lifecycle.capture();
        const originalQuery = lifecycle.queryOptions(currentSessionEndpoint, {}, [
            'account-preferences',
        ]);
        await lifecycle.queryClient.fetchQuery(originalQuery);
        const observer = effectScope();
        const query = observer.run(() =>
            useSessionQuery(currentSessionEndpoint, {}, ['account-preferences'], lifecycle),
        )!;
        disposals.push(() => observer.stop());
        form.draft.value.defaultTimezone = 'Asia/Shanghai';
        expect(await form.submit()).toBe('success');
        expect(lifecycle.session.user?.preferences.defaultTimezone).toBe('Asia/Shanghai');
        expect(originalScope.signal.aborted).toBe(true);
        expect(lifecycle.queryClient.getQueryData(originalQuery.queryKey)).toBeUndefined();
        await nextTick();
        await query.refetch();
        expect(query.data.value?.data.user.preferences.defaultTimezone).toBe('Asia/Shanghai');
        const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
        expect(typeof patch[1]?.body).toBe('string');
        expect(JSON.parse(patch[1]?.body as string)).toEqual({ defaultTimezone: 'Asia/Shanghai' });
        expect(new Headers(patch[1]?.headers).get('x-csrf-token')).toBe(account.csrfToken);
        expect(form.dirty.value).toBe(false);
        expect(form.saved.value).toBe(true);
    });
    it('does not overwrite edits with a late read or same-account background recovery', async () => {
        const { lifecycle, form } = setup();
        form.draft.value.defaultTimezone = 'Europe/London';
        form.acceptServer({
            ...account.user,
            preferences: { ...account.user.preferences, defaultTimezone: 'Asia/Tokyo' },
        });
        lifecycle.replaceSession({
            ...account,
            user: {
                ...account.user,
                preferences: { ...account.user.preferences, defaultTimezone: 'Asia/Tokyo' },
            },
        });
        await nextTick();
        expect(form.draft.value.defaultTimezone).toBe('Europe/London');
        expect(form.dirty.value).toBe(true);
    });
    it('locks repeated submits and cannot be overwritten by a read while saving', async () => {
        const response = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(() => response.promise);
        const { form } = setup(fetcher);
        form.draft.value.defaultTimezone = 'Asia/Tokyo';
        const result = form.submit();
        expect(await form.submit()).toBe('ignored');
        form.acceptServer(account.user);
        expect(form.draft.value.defaultTimezone).toBe('Asia/Tokyo');
        response.resolve(
            Response.json({
                ...account,
                user: {
                    ...account.user,
                    preferences: { ...account.user.preferences, defaultTimezone: 'Asia/Tokyo' },
                },
            }),
        );
        expect(await result).toBe('success');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each([422, 429, 403, 503])(
        'retains edits and reports HTTP %i without automatic retry',
        async (status) => {
            const fetcher = vi.fn<typeof fetch>(async () =>
                failure(
                    status,
                    status === 422 ? [{ path: '/defaultTimezone', message: 'sample' }] : undefined,
                ),
            );
            const { lifecycle, form } = setup(fetcher);
            form.draft.value.defaultTimezone = 'Europe/London';
            expect(await form.submit()).toBe(status === 422 ? 'invalid' : 'error');
            expect(form.draft.value.defaultTimezone).toBe('Europe/London');
            expect(form.saved.value).toBe(false);
            expect(form.message.value).not.toBe('');
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(lifecycle.session.user?.id).toBe(account.user.id);
            if (status === 422) expect(form.firstField.value).toBe('defaultTimezone');
            if (status === 429) expect(form.message.value).toContain('频繁');
        },
    );
    it('keeps edits on offline failure and allows explicit retry', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(
                Response.json({
                    ...account,
                    user: {
                        ...account.user,
                        preferences: {
                            ...account.user.preferences,
                            defaultTimezone: 'Europe/London',
                        },
                    },
                }),
            );
        const { form } = setup(fetcher);
        form.draft.value.defaultTimezone = 'Europe/London';
        expect(await form.submit()).toBe('error');
        expect(form.message.value).toContain('检查网络');
        expect(await form.submit()).toBe('success');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('uses current 401 lifecycle clearing and never installs a different account response', async () => {
        const { lifecycle, form } = setup(async () => failure(401));
        expect(await form.submit({ defaultTimezone: 'UTC' })).toBe('cancelled');
        expect(lifecycle.session.user).toBeNull();
        const other = setup(async () =>
            Response.json({
                ...account,
                user: { ...account.user, id: '00000000-0000-4000-8000-000000000002' },
            }),
        );
        expect(await other.form.submit({ defaultTimezone: 'UTC' })).toBe('invalid');
        expect(other.lifecycle.session.user?.id).toBe(account.user.id);
    });
    it.each([200, 401, 403])(
        'ignores late HTTP %i from an old account and resets the new draft safely',
        async (status) => {
            const response = deferred<Response>();
            let signal: AbortSignal | undefined;
            const { lifecycle, form } = setup(async (_url, init) => {
                signal = init?.signal ?? undefined;
                return response.promise;
            });
            const result = form.submit({ defaultTimezone: 'Asia/Tokyo' });
            await vi.waitFor(() => expect(signal).toBeDefined());
            const other = {
                ...account,
                user: {
                    ...account.user,
                    id: '00000000-0000-4000-8000-000000000002',
                    preferences: { ...account.user.preferences, defaultTimezone: 'Europe/London' },
                },
            };
            lifecycle.replaceSession(other);
            response.resolve(status === 200 ? Response.json(account) : failure(status));
            expect(await result).toBe('cancelled');
            await nextTick();
            expect(signal?.aborted).toBe(true);
            expect(lifecycle.session.user?.id).toBe(other.user.id);
            expect(form.draft.value.defaultTimezone).toBe('Europe/London');
            expect(form.message.value).toBe('');
        },
    );
    it('cancels an unmounted save and cannot update the session later', async () => {
        const response = deferred<Response>();
        let signal: AbortSignal | undefined;
        const { lifecycle, form } = setup(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return response.promise;
        });
        const epoch = lifecycle.session.epoch;
        const result = form.submit({ defaultTimezone: 'Asia/Tokyo' });
        await vi.waitFor(() => expect(signal).toBeDefined());
        form.dispose();
        response.resolve(Response.json(account));
        expect(await result).toBe('cancelled');
        expect(signal?.aborted).toBe(true);
        expect(lifecycle.session.epoch).toBe(epoch);
        expect(form.message.value).toBe('');
    });
});
