import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveApiBaseUrl } from '@/api/config';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('public API address configuration', () => {
    it.each([
        [undefined, '/api/v1'],
        ['/api/v1/', '/api/v1'],
        ['http://localhost:3000/api/v1', 'http://localhost:3000/api/v1'],
        ['https://api.example.test/scova/api/v1/', 'https://api.example.test/scova/api/v1'],
    ])('accepts %s', (value, expected) => expect(resolveApiBaseUrl(value)).toBe(expected));
    it.each([
        '//evil.test/api/v1',
        'ftp://api.test/api/v1',
        'https://u:p@api.test/api/v1',
        'https://api.test/api/v1?key=secret',
        'https://api.test/api/v1#x',
        '/api',
        '/api\\v1',
        'api/v1',
    ])('rejects invalid configuration %s', (value) =>
        expect(() => resolveApiBaseUrl(value)).toThrow(),
    );
    it('uses the configured direct address and cookies for both HTTP and native SSE', async () => {
        vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/api/v1');
        vi.resetModules();
        const { createApi } = await import('@/api/client');
        const { defineApiEndpoint } = await import('@/api/endpoints');
        const { apiUrl, apiCredentials } = await import('@/api/config');
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
        const api = createApi({ fetcher });
        try {
            const endpoint = defineApiEndpoint<{ data: { ok: boolean } }>({
                method: 'GET',
                path: '/sample',
                validator: { parse: () => ({ ok: true }) },
            });
            await api.request(endpoint, {});
            await api.transport.native(apiUrl('/runs/sample/events?after=2'), {
                credentials: apiCredentials,
            });
            expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.test/api/v1/sample');
            expect(fetcher.mock.calls[1]?.[0]).toBe(
                'https://api.example.test/api/v1/runs/sample/events?after=2',
            );
            for (const [, init] of fetcher.mock.calls) expect(init?.credentials).toBe('include');
        } finally {
            api.dispose();
        }
    });
});
