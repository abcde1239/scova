import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vite-plus/test';
import { nodeHttpTransport } from '../src/http.ts';

describe('web text over the real pinned Node transport (privileged local fixture)', () => {
    it('signals response headers before the complete bounded body has arrived', async () => {
        let finishBody!: () => void;
        let headersStarted!: () => void;
        const headers = new Promise<void>((resolve) => {
            headersStarted = resolve;
        });
        const server = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.flushHeaders();
            finishBody = () => response.end('<article>complete slow body</article>');
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('fixture has no TCP port');
        let complete = false;
        try {
            const pending = nodeHttpTransport(
                new URL(`http://fixture.example:${address.port}/article`),
                {
                    address: { address: '127.0.0.1', family: 4 },
                    method: 'GET',
                    headers: {},
                    maxBytes: 1024,
                    signal: AbortSignal.timeout(2000),
                    responseEncoding: 'web-text',
                    onResponseStarted: headersStarted,
                },
            ).then((response) => {
                complete = true;
                return response;
            });
            await headers;
            expect(complete).toBe(false);
            finishBody();
            expect((await pending).body).toBe('<article>complete slow body</article>');
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });
    it('decodes compressed HTML/legacy charset and retains empty redirects and HTTP errors', async () => {
        const server = createServer((request, response) => {
            if (request.url === '/redirect') {
                response.writeHead(302, { location: '/gzip' });
                response.end();
            } else if (request.url === '/error') {
                response.writeHead(503, { 'content-type': 'application/octet-stream' });
                response.end(Buffer.from([255, 254]));
            } else if (request.url === '/legacy') {
                response.writeHead(200, { 'content-type': 'text/html; charset=gb2312' });
                response.end(
                    Buffer.concat([
                        Buffer.from('<article>'),
                        Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
                        Buffer.from('</article>'),
                    ]),
                );
            } else {
                const brotli = request.url === '/br';
                response.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'content-encoding': brotli ? 'br' : 'gzip',
                });
                response.end(
                    (brotli ? brotliCompressSync : gzipSync)(
                        Buffer.from('<article>压缩正文</article>'),
                    ),
                );
            }
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('fixture has no TCP port');
        const send = (path: string) =>
            nodeHttpTransport(new URL(`http://fixture.example:${address.port}${path}`), {
                address: { address: '127.0.0.1', family: 4 },
                method: 'GET',
                headers: {},
                maxBytes: 1024,
                signal: AbortSignal.timeout(2000),
                responseEncoding: 'web-text',
            });
        try {
            for (const path of ['/gzip', '/br']) {
                const result = await send(path);
                expect(result.body).toBe('<article>压缩正文</article>');
                expect(result.headers).not.toHaveProperty('content-encoding');
            }
            expect((await send('/legacy')).body).toBe('<article>中文</article>');
            expect(await send('/redirect')).toMatchObject({
                status: 302,
                headers: { location: '/gzip' },
                body: '',
            });
            expect(await send('/error')).toMatchObject({ status: 503, body: '' });
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });
});
