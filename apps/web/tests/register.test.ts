import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createSessionLifecycle } from '@/api/session';
import { createRegisterController } from '@/composables/useRegister';

const input = {
    email: 'new@example.test',
    password: 'sample-password-29',
    defaultTimezone: 'Asia/Shanghai',
};
const account = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: input.email,
        preferences: {
            defaultTimezone: input.defaultTimezone,
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'sample-registration-csrf',
};
const active: ReturnType<typeof createSessionLifecycle>[] = [];
function setup(fetcher: typeof fetch = async () => Response.json(account, { status: 201 })) {
    const lifecycle = createSessionLifecycle({ fetcher });
    active.push(lifecycle);
    return { lifecycle, registration: createRegisterController(lifecycle) };
}
afterEach(() => active.splice(0).forEach((lifecycle) => lifecycle.dispose()));

describe('registration', () => {
    it.each([8, 128])(
        'accepts password boundary %s and installs one cookie-backed session',
        async (length) => {
            const fetcher = vi
                .fn<typeof fetch>()
                .mockResolvedValue(Response.json(account, { status: 201 }));
            const { lifecycle, registration } = setup(fetcher);
            expect(await registration.submit({ ...input, password: 'a'.repeat(length) })).toBe(
                'success',
            );
            expect(fetcher.mock.calls[0]![0]).toBe('/api/v1/auth/register');
            expect(fetcher.mock.calls[0]![1]?.credentials).toBe('include');
            expect(lifecycle.session.user?.id).toBe(account.user.id);
            expect(JSON.stringify(lifecycle.pinia.state.value)).not.toContain(account.csrfToken);
            expect(JSON.stringify(lifecycle.pinia.state.value)).not.toContain('password');
        },
    );
    it.each([
        [{ ...input, email: 'bad' }, 'email'],
        [{ ...input, password: 'a'.repeat(7) }, 'password'],
        [{ ...input, password: 'a'.repeat(129) }, 'password'],
        [{ ...input, defaultTimezone: 'Not/AZone' }, 'defaultTimezone'],
    ] as const)('validates before requesting %s', async (value, field) => {
        const fetcher = vi.fn<typeof fetch>();
        const { registration } = setup(fetcher);
        expect(await registration.submit(value)).toBe('invalid');
        expect(registration.firstField.value).toBe(field);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each([
        [409, 'EMAIL_ALREADY_REGISTERED', '该邮箱已注册'],
        [403, 'REGISTRATION_DISABLED', '关闭注册'],
        [429, 'RATE_LIMITED', '频繁'],
    ] as const)('handles server policy %s/%s', async (status, code, text) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(
                Response.json({ code, message: 'sample', requestId: 'sample' }, { status }),
            );
        const { lifecycle, registration } = setup(fetcher);
        await registration.submit(input);
        expect(`${registration.message.value}${registration.fields.value.email ?? ''}`).toContain(
            text,
        );
        expect(lifecycle.session.user).toBeNull();
        if (status === 403) {
            expect(registration.closed.value).toBe(true);
            expect(await registration.submit(input)).toBe('ignored');
            expect(fetcher).toHaveBeenCalledTimes(1);
        }
    });
    it('locks synchronous overlap and ignores canceled late registration', async () => {
        let complete!: (response: Response) => void;
        const fetcher = vi.fn<typeof fetch>().mockImplementation(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const { lifecycle, registration } = setup(fetcher);
        const pending = registration.submit(input);
        expect(registration.pending.value).toBe(true);
        expect(await registration.submit(input)).toBe('ignored');
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        registration.dispose();
        complete(Response.json(account, { status: 201 }));
        expect(await pending).toBe('cancelled');
        expect(lifecycle.session.user).toBeNull();
        expect(registration.message.value).toBe('');
    });
    it('allows retry after network failure', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new TypeError('offline'))
            .mockResolvedValueOnce(Response.json(account, { status: 201 }));
        const { registration } = setup(fetcher);
        expect(await registration.submit(input)).toBe('error');
        expect(registration.message.value).toContain('网络');
        expect(await registration.submit(input)).toBe('success');
    });
});
