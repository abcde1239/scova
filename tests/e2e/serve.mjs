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
api.listen(0, '127.0.0.1');
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
            proxy: { '/api/v1': `http://127.0.0.1:${api.address().port}` },
        },
    });
} catch (error) {
    await close();
    throw error;
}
