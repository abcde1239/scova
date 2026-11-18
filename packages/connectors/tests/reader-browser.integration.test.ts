import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    createPageReader as createNativePageReader,
    createSafeHttpClient,
    pageFingerprint,
    BROWSER_EXTRACTION_VERSION,
    ConnectorError,
    type HttpTransport,
    type PageReader,
} from '../src/index.ts';

import { createDelegatedReader } from '../src/reader/runtime/delegate.ts';
const url = 'https://fixture.example/article';
const article =
    '<article><h1>Dynamic publication</h1><p>Rendered evidence from the controlled browser fixture. The application deadline is 15 November 2026.</p><p>This text must be collected from the rendered document and remain untrusted source data.</p></article>';
const readers: PageReader[] = [];
afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.close?.() ?? Promise.resolve()));
});
describe.each([
    ['native', createNativePageReader],
    ['Node host', createDelegatedReader],
] as const)('%s Crawlee + Playwright Reader', (_name, createPageReader) => {
    function fixture(
        html: string,
        resources: Record<string, { body: string; type: string }> = {},
        options: { maxTextChars?: number; finalUrl?: string } = {},
    ) {
        const transport = vi.fn<HttpTransport>(async (target) => {
            if (target.pathname === '/article')
                return { status: 200, headers: { 'content-type': 'text/html' }, body: html };
            const resource = resources[target.pathname];
            if (!resource) throw new Error(`Unexpected fixture request: ${target.pathname}`);
            return { status: 200, headers: { 'content-type': resource.type }, body: resource.body };
        });
        const pinned = createSafeHttpClient({
            resolve: async (hostname) => [
                {
                    address: hostname === 'private.example' ? '127.0.0.1' : '93.184.216.34',
                    family: 4,
                },
            ],
            transport,
        });
        const http = options.finalUrl
            ? {
                  async request(...args: Parameters<typeof pinned.request>) {
                      const response = await pinned.request(...args);
                      return args[0] === url ? { ...response, url: options.finalUrl! } : response;
                  },
              }
            : pinned;
        const reader = createPageReader({
            http,
            maxTextChars: options.maxTextChars,
            renderWaitMs: 300,
        });
        readers.push(reader);
        return { reader, transport };
    }

    it('executes external JavaScript, loads JSON, retains publication metadata and hashes actual rendered text', async () => {
        const { reader, transport } = fixture(
            '<!doctype html><title>Dynamic</title><main id="root">Loading</main><script src="/app.js"></script>',
            {
                '/app.js': {
                    type: 'application/javascript',
                    body: `setTimeout(async()=>{const r=await fetch('/data'); const d=await r.json();document.getElementById('root').innerHTML=d.html;const meta=document.createElement('meta');meta.setAttribute('property','article:published_time');meta.content='2026-11-09T00:00:00Z';document.head.append(meta);},50)`,
                },
                '/data': { type: 'application/json', body: JSON.stringify({ html: article }) },
            },
        );
        const beforeAttempt = vi.fn();
        const page = await reader.read(url, { beforeAttempt });
        expect(page.text).toContain('Rendered evidence');
        expect(page.text).not.toContain('Loading');
        expect(page).toMatchObject({
            kind: 'read_page',
            mode: 'live',
            untrusted: true,
            extractionVersion: BROWSER_EXTRACTION_VERSION,
            contentHash: pageFingerprint(page.text),
            publication: { status: 'known', instant: '2026-11-09T00:00:00.000Z' },
        });
        expect(beforeAttempt).toHaveBeenCalledExactlyOnceWith('read', undefined);
        expect(transport.mock.calls.map(([target]) => target.pathname)).toEqual([
            '/article',
            '/app.js',
            '/data',
        ]);
    });
    it('blocks private DNS, direct IP access, writes, iframes, WebSockets and media; never forwards page cookies or authorization', async () => {
        const { reader, transport } = fixture(
            `<!doctype html><main id="root">Loading</main><iframe src="https://private.example/frame"></iframe><img src="/image.png"><script>
            document.getElementById('root').innerHTML=${JSON.stringify(article)};
            document.cookie='private_cookie=secret';
            fetch('https://private.example/metadata').catch(()=>{});
            fetch('http://127.0.0.1/admin').catch(()=>{});
            fetch('/write',{method:'POST',body:'mutation'}).catch(()=>{});
            fetch('/data',{headers:{Authorization:'Bearer page-secret'}}).catch(()=>{});
            new WebSocket('wss://private.example/socket');
            navigator.serviceWorker.register('/sw.js').catch(()=>{});
        </script>`,
            { '/data': { type: 'application/json', body: '{}' } },
        );
        expect((await reader.read(url)).text).toContain('Rendered evidence');
        expect(transport.mock.calls.map(([target]) => target.pathname).sort()).toEqual([
            '/article',
            '/data',
        ]);
        for (const [, request] of transport.mock.calls) {
            expect(request.method).toBe('GET');
            expect(request.headers).not.toHaveProperty('authorization');
            expect(request.headers).not.toHaveProperty('cookie');
        }
    });
    it('extracts from the safe final URL, preserves the original and applies exact text truncation', async () => {
        const { reader } = fixture(
            article,
            {},
            { finalUrl: 'https://fixture.example/final/article', maxTextChars: 50 },
        );
        const page = await reader.read(url);
        expect(page).toMatchObject({
            originalUrl: url,
            fetchedUrl: 'https://fixture.example/final/article',
            url: 'https://fixture.example/final/article',
            truncated: true,
        });
        expect(page.text).toHaveLength(50);
        expect(page.contentHash).toBe(pageFingerprint(page.text));
    });
    it('rejects page-initiated navigation without making a second document request', async () => {
        const { reader, transport } = fixture(
            `<main>Loading</main><script>location.href='https://other.example/new-document';</script>`,
        );
        await expect(reader.read(url)).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('bounds resource request fan-out and rendered DOM size', async () => {
        const resources = Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [
                `/data-${i}`,
                { type: 'application/json', body: '{}' },
            ]),
        );
        const first = fixture(
            `<main id="root">Loading</main><script>document.getElementById('root').innerHTML=${JSON.stringify(article)};for(let i=0;i<40;i++)fetch('/data-'+i).catch(()=>{});</script>`,
            resources,
        );
        const limited = await first.reader.read(url);
        expect(limited.text).toContain('Rendered evidence');
        expect(limited.collection).toMatchObject({
            complete: false,
            limitations: ['resource_limit'],
        });
        expect(first.transport.mock.calls.length).toBeLessThanOrEqual(32);
        const second = fixture(
            `<main id="root">Loading</main><script>document.getElementById('root').innerHTML=${JSON.stringify(article)};document.body.append('x'.repeat(2*1024*1024));</script>`,
        );
        await expect(second.reader.read(url)).rejects.toMatchObject({ code: 'response_too_large' });
    });
    it('reserves before all network work and does not start a browser when budget is denied', async () => {
        const { reader, transport } = fixture(article);
        await expect(
            reader.read(url, {
                beforeAttempt: () => {
                    throw new ConnectorError('budget_exceeded', 'no pages');
                },
            }),
        ).rejects.toMatchObject({ code: 'budget_exceeded' });
        expect(transport).not.toHaveBeenCalled();
        const repositoryError = Object.assign(new Error('private repository fixture'), {
            code: 'BUDGET_EXCEEDED',
        });
        await expect(
            reader.read(url, {
                beforeAttempt: () => {
                    throw repositoryError;
                },
            }),
        ).rejects.toBe(repositoryError);
        expect(transport).not.toHaveBeenCalled();
    });
    it.each(['network', 'timeout'] as const)(
        'reserves a main-document %s retry and preserves its identity across the Node pipe',
        async (code) => {
            let attempt = 0;
            const beforeAttempt = vi.fn();
            const reader = createPageReader({
                renderWaitMs: 100,
                http: createSafeHttpClient({
                    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                    transport: async () => {
                        if (++attempt === 1)
                            throw new ConnectorError(code, 'fixture transient', true);
                        return {
                            status: 200,
                            headers: { 'content-type': 'text/html' },
                            body: article,
                        };
                    },
                }),
            });
            readers.push(reader);
            expect((await reader.read(url, { beforeAttempt })).text).toContain('Rendered evidence');
            expect(attempt).toBe(2);
            expect(beforeAttempt).toHaveBeenCalledTimes(2);
            expect(beforeAttempt.mock.calls[1]![1]).toBeInstanceOf(ConnectorError);
            expect(beforeAttempt.mock.calls[1]![1]).toMatchObject({ code, retryable: true });
        },
    );
    it('caps cumulative resource bytes and does not dispatch queued resources after overflow', async () => {
        const { reader, transport } = fixture(
            `<main id="root">Loading</main><script>document.getElementById('root').innerHTML=${JSON.stringify(article)};for(let i=0;i<8;i++)fetch('/large-'+i).catch(()=>{});</script>`,
            Object.fromEntries(
                Array.from({ length: 8 }, (_, i) => [
                    `/large-${i}`,
                    {
                        type: 'application/json',
                        body: JSON.stringify('x'.repeat(2 * 1024 * 1024 - 2)),
                    },
                ]),
            ),
        );
        const limited = await reader.read(url);
        expect(limited.text).toContain('Rendered evidence');
        expect(limited.collection?.complete).toBe(false);
        expect(limited.collection?.limitations).toContain('resource_limit');
        // Three complete 2 MiB resources plus the main page fit. The fourth exceeds
        // the remaining budget; no later request may reach even an injected transport.
        expect(transport).toHaveBeenCalledTimes(5);
        expect(transport.mock.calls[4]![1].maxBytes).toBeLessThan(2 * 1024 * 1024);
    });
    it('never dispatches queued or pre-cancelled reads and respects close before first use', async () => {
        const controller = new AbortController();
        controller.abort();
        const { reader, transport } = fixture(article);
        await expect(reader.read(url, { signal: controller.signal })).rejects.toMatchObject({
            code: 'aborted',
        });
        expect(transport).not.toHaveBeenCalled();
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const first = reader.read(url, {
            beforeAttempt: async () => {
                entered();
                await waiting;
            },
        });
        const firstResult = first.then(
            (page) => page,
            (error) => error,
        );
        await started;
        await expect(reader.read(url, { timeoutMs: 50 })).rejects.toMatchObject({
            code: 'timeout',
        });
        release();
        expect((await firstResult).text).toContain('Rendered evidence');
        expect(transport).toHaveBeenCalledTimes(1);
        const unused = createPageReader({});
        readers.push(unused);
        await unused.close?.();
        await expect(unused.read(url)).rejects.toMatchObject({ code: 'aborted' });
    });
    it.each(['signal', 'close'] as const)(
        'cancels an in-flight resource via %s and closes Chromium before shutdown resolves',
        async (mode) => {
            let started!: () => void;
            const resourceStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            const transport = vi.fn<HttpTransport>(async (target, request) => {
                if (target.pathname === '/article')
                    return {
                        status: 200,
                        headers: { 'content-type': 'text/html' },
                        body: `<main id="root">Loading</main><script>document.getElementById('root').innerHTML=${JSON.stringify(article)};</script><script src="/slow.js"></script>`,
                    };
                started();
                await new Promise((_, reject) =>
                    request.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
                        once: true,
                    }),
                );
                throw new Error('unreachable');
            });
            const reader = createPageReader({
                http: createSafeHttpClient({
                    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                    transport,
                }),
            });
            readers.push(reader);
            const controller = new AbortController();
            const result = reader.read(url, { signal: controller.signal });
            const settled = result.then(
                () => null,
                (error) => error as ConnectorError,
            );
            await Promise.race([
                resourceStarted,
                settled.then((error) => {
                    throw error ?? new Error('resource did not start');
                }),
            ]);
            if (mode === 'signal') controller.abort();
            else await reader.close?.();
            expect(await settled).toMatchObject({ code: 'aborted' });
            await reader.close?.();
            await expect(reader.read(url)).rejects.toMatchObject({ code: 'aborted' });
            expect(transport).toHaveBeenCalledTimes(2);
        },
    );
});
