// Local HTTP samples for component/browser regressions, never a real account backend.
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const webRoot = path.join(root, 'apps/web');
const require = createRequire(path.join(webRoot, 'package.json'));
const { preview } = await import(pathToFileURL(require.resolve('vite')).href);
const sample = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'browser-sample@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'browser-sample-only',
};
const api = http.createServer((request, response) => {
    response.setHeader('access-control-allow-origin', 'http://127.0.0.1:4189');
    response.setHeader('access-control-allow-credentials', 'true');
    if (request.method === 'OPTIONS') {
        response.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'access-control-allow-headers':
                'content-type, x-csrf-token, idempotency-key, if-match, last-event-id',
        });
        response.end();
        return;
    }
    if (request.url === '/api/v1/__sample/session' && request.method === 'POST') {
        response.writeHead(204, {
            'set-cookie': 'scova_connection_sample=accepted; Path=/; HttpOnly; SameSite=Lax',
        });
        response.end();
        return;
    }
    if (request.url === '/api/v1/__sample/events' && request.method === 'GET') {
        if (!request.headers.cookie?.includes('scova_connection_sample=accepted')) {
            response.writeHead(401);
            response.end();
            return;
        }
        response.writeHead(200, {
            'content-type': 'text/event-stream',
            etag: '"sample"',
            'access-control-expose-headers': 'ETag',
        });
        response.end('data: cookie-accepted\n\n');
        return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/me') {
        response.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
        });
        response.end(JSON.stringify(sample));
        return;
    }
    response.writeHead(404);
    response.end();
});
api.listen(4190, '127.0.0.1');
await once(api, 'listening');
let server;
async function close() {
    await new Promise((resolve) => api.close(resolve));
    if (server) await new Promise((resolve) => server.httpServer.close(resolve));
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
try {
    server = await preview({
        root: webRoot,
        mode: 'test',
        preview: {
            host: '127.0.0.1',
            port: 4189,
            strictPort: true,
        },
    });
} catch (error) {
    await close();
    throw error;
}
