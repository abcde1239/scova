import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { createLoginController } from '@/composable/useLogin';

const account: SessionResponse = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'a@example.org',
        preferences: {
            defaultTimezone: 'Asia/Shanghai',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'local-test-csrf',
};
const active: ReturnType<typeof createSessionLifecycle>[] = [];
function setup(fetcher: typeof fetch = async () => Response.json(account)) {
    const lifecycle = createSessionLifecycle({ fetcher });
    active.push(lifecycle);
    return { lifecycle, login: createLoginController(lifecycle) };
}
afterEach(() => {
    active.splice(0).forEach((lifecycle) => lifecycle.dispose());
});

describe('login submission', () => {
    it('accepts the login schema minimum password and installs one session without exposing credentials', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(account));
        const { lifecycle, login } = setup(fetcher);
        expect(await login.submit({ email: 'a@example.org', password: 'x' })).toBe('success');
        expect(lifecycle.session.user).toEqual(account.user);
        expect(lifecycle.session.epoch).toBe(1);
        const [url, init] = fetcher.mock.calls[0]!;
        expect(url).toBe('/api/v1/auth/login');
        expect(typeof init?.body).toBe('string');
        expect(JSON.parse(init!.body as string)).toEqual({ email: 'a@example.org', password: 'x' });
        expect(init?.credentials).toBe('include');
        expect(JSON.stringify(lifecycle.pinia.state.value)).not.toContain('password');
        expect(JSON.stringify(lifecycle.pinia.state.value)).not.toContain(account.csrfToken);
    });
    it.each([
        [{ email: 'wrong', password: '' }, 'email'],
        [{ email: 'a@example.org', password: '' }, 'password'],
        [{ email: 'a@example.org', password: 'x'.repeat(129) }, 'password'],
    ] as const)('validates fields before any request: %s', async (input, first) => {
        const fetcher = vi.fn<typeof fetch>();
        const { login } = setup(fetcher);
        expect(await login.submit(input)).toBe('invalid');
        expect(login.firstField.value).toBe(first);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('locks before asynchronous validation/dispatch and allows a later user attempt', async () => {
        let resolve!: (response: Response) => void;
        const fetcher = vi.fn<typeof fetch>().mockImplementation(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const { login } = setup(fetcher);
        const first = login.submit({ email: 'a@example.org', password: 'x' });
        expect(login.pending.value).toBe(true);
        expect(await login.submit({ email: 'a@example.org', password: 'x' })).toBe('ignored');
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        resolve(
            Response.json(
                { code: 'UNAUTHORIZED', message: 'bad credentials', requestId: 'test' },
                { status: 401 },
            ),
        );
        expect(await first).toBe('error');
        expect(login.pending.value).toBe(false);
        expect(login.message.value).toBe('邮箱或密码不正确');
    });
    it.each([401, 429])('reports %i without installing a user', async (status) => {
        const { lifecycle, login } = setup(async () =>
            Response.json(
                { code: 'AUTH_FAILURE', message: 'server message', requestId: 'test' },
                { status },
            ),
        );
        expect(await login.submit({ email: 'a@example.org', password: 'x' })).toBe('error');
        expect(login.message.value).toContain(status === 401 ? '邮箱或密码' : '频繁');
        expect(lifecycle.session.user).toBeNull();
    });
    it('maps server field failures to the first local field', async () => {
        const { login } = setup(async () =>
            Response.json(
                {
                    code: 'VALIDATION_ERROR',
                    message: 'bad field',
                    requestId: 'test',
                    fieldErrors: [{ path: '/email', message: 'invalid' }],
                },
                { status: 422 },
            ),
        );
        expect(await login.submit({ email: 'a@example.org', password: 'x' })).toBe('invalid');
        expect(login.firstField.value).toBe('email');
    });
    it('cancels a leaving form without overwriting the next session', async () => {
        let resolve!: (response: Response) => void;
        const fetcher = vi.fn<typeof fetch>().mockImplementation(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const { lifecycle, login } = setup(fetcher);
        const result = login.submit({ email: 'a@example.org', password: 'x' });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        login.dispose();
        const next = {
            ...account,
            user: { ...account.user, id: '00000000-0000-4000-8000-000000000002' },
        };
        lifecycle.replaceSession(next);
        resolve(Response.json(account));
        expect(await result).toBe('cancelled');
        expect(lifecycle.session.user?.id).toBe(next.user.id);
        expect(login.message.value).toBe('');
    });
});
