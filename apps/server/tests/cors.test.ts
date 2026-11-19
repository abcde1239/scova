import { describe, expect, it } from 'vite-plus/test';
import { Elysia } from 'elysia';
import { node } from '@elysiajs/node';
import { createApiApp } from '../src/app/index';
import { createDefaultServices } from '../src/app/services';
import { createApiErrorPlugin } from '../src/app/errors';
import { createCorsPlugin } from '../src/handler/http/cors';

const origin = 'http://localhost:5173';
const request = (path = '/health', init?: RequestInit) =>
    new Request(`http://localhost:3000${path}`, init);

describe('direct browser API connection', () => {
    it('allows credentialed preflight without connecting external services', async () => {
        const app = createApiApp('node', createDefaultServices({ origin }));
        const response = await app.handle(
            request('/api/v1/me/preferences', {
                method: 'OPTIONS',
                headers: {
                    origin,
                    'access-control-request-method': 'PATCH',
                    'access-control-request-headers':
                        'Content-Type, X-CSRF-Token, If-Match, Idempotency-Key',
                },
            }),
        );
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        expect(response.headers.get('access-control-allow-credentials')).toBe('true');
        expect(response.headers.get('access-control-allow-headers')).toContain('if-match');
        expect(response.headers.get('vary')).toContain('Access-Control-Request-Headers');
    });
    it('adds CORS to success and errors, and exposes concurrency and retry headers', async () => {
        const app = createApiApp('node', createDefaultServices({ origin }));
        for (const path of ['/health', '/api/v1/missing']) {
            const response = await app.handle(request(path, { headers: { origin } }));
            expect(response.status).toBe(path === '/health' ? 200 : 404);
            expect(response.headers.get('access-control-allow-origin')).toBe(origin);
            expect(response.headers.get('access-control-expose-headers')).toBe(
                'ETag, Retry-After, X-Request-Id',
            );
        }
    });
    it.each([
        {
            origin: 'https://untrusted.test',
            'access-control-request-method': 'GET',
            'access-control-request-headers': '',
        },
        {
            origin,
            'access-control-request-method': 'CONNECT',
            'access-control-request-headers': '',
        },
        {
            origin,
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'authorization',
        },
    ])('rejects untrusted preflight %j', async (headers) => {
        const app = createApiApp('node', createDefaultServices({ origin }));
        const response = await app.handle(
            request('/api/v1/me', {
                method: 'OPTIONS',
                headers,
            }),
        );
        expect(response.status).toBe(403);
        if (headers.origin !== origin)
            expect(response.headers.has('access-control-allow-origin')).toBe(false);
    });
    it('preserves Cookie and streaming response headers', async () => {
        const app = new Elysia({ adapter: node() })
            .use(createApiErrorPlugin())
            .use(createCorsPlugin(origin))
            .get(
                '/sample',
                () =>
                    new Response('data: sample\n\n', {
                        headers: {
                            'content-type': 'text/event-stream',
                            'set-cookie': 'sample=1; HttpOnly; SameSite=Lax',
                            etag: '"2"',
                        },
                    }),
            );
        const response = await app.handle(request('/sample', { headers: { origin } }));
        expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        expect(response.headers.get('set-cookie')).toContain('HttpOnly');
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        expect(response.headers.get('etag')).toBe('"2"');
    });
});
