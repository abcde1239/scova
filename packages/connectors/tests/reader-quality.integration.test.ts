import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createPageReader as createNativePageReader,
    createSafeHttpClient,
    pageFingerprint,
    type HttpTransport,
    type PageReader,
} from '../src/index.ts';
import { createDelegatedReader } from '../src/reader/runtime/delegate.ts';

const url = 'https://fixture.example/article';
const paragraphs = Array.from(
    { length: 8 },
    (_, index) =>
        `第${index + 1}段：本馆于2026年11月发布开放安排，读者可以在开放时间查阅馆藏并预约研究席位。每项安排均以本公告所载日期、对象和办理条件为准，请保留末段的联系方式以核实实际安排。`,
);
const article = `<article><h1>图书馆开放安排</h1>${paragraphs.map((text) => `<p>${text}</p>`).join('')}<p>全文末尾核验标记：LIBRARY-NOTICE-END-2026。</p></article>`;
const readers: PageReader[] = [];

afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.close?.() ?? Promise.resolve()));
});

describe.each([
    ['native', createNativePageReader],
    ['Node host', createDelegatedReader],
] as const)('%s Reader body quality and resource degradation', (_name, createPageReader) => {
    function fixture(transport: HttpTransport) {
        const observed = vi.fn(transport);
        const reader = createPageReader({
            http: createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport: observed,
            }),
            renderWaitMs: 300,
        });
        readers.push(reader);
        return { reader, transport: observed };
    }

    function response(body: string, type = 'text/html') {
        return { status: 200, headers: { 'content-type': `${type}; charset=utf-8` }, body };
    }

    it.each(['many', 'large', 'slow'] as const)(
        'collects the whole static article without requesting %s optional resources',
        async (kind) => {
            const scripts =
                kind === 'many'
                    ? Array.from(
                          { length: 40 },
                          (_, index) => `<script async src="/optional-${index}.js"></script>`,
                      ).join('')
                    : '<script async src="/optional.js"></script>';
            const { reader, transport } = fixture(async (target, options) => {
                if (target.pathname === '/article')
                    return response(`<!doctype html>${article}${scripts}`);
                if (kind === 'large')
                    return response('x'.repeat(2 * 1024 * 1024 + 1), 'application/javascript');
                if (kind === 'slow') {
                    await new Promise<void>((_resolve, reject) => {
                        options.signal.addEventListener(
                            'abort',
                            () => reject(new Error('cancelled')),
                            { once: true },
                        );
                    });
                }
                return response('', 'application/javascript');
            });
            const page = await reader.read(url);
            for (const paragraph of paragraphs) expect(page.text).toContain(paragraph);
            expect(page.text).toContain('LIBRARY-NOTICE-END-2026');
            expect(page.truncated).toBe(false);
            expect(page.contentHash).toBe(pageFingerprint(page.text));
            expect(page.collection).toEqual({
                version: 1,
                method: 'html',
                complete: true,
                limitations: [],
            });
            expect(transport.mock.calls.map(([target]) => target.pathname)).toEqual(['/article']);
        },
    );

    it('renders a loading shell and collects the body inserted by the application', async () => {
        const { reader, transport } = fixture(async (target) => {
            if (target.pathname === '/article')
                return response(
                    '<!doctype html><main id="root">加载中</main><script src="/app.js"></script>',
                );
            if (target.pathname === '/app.js')
                return response(
                    `setTimeout(()=>{document.getElementById('root').innerHTML=${JSON.stringify(article)}},50)`,
                    'application/javascript',
                );
            throw new Error(`Unexpected fixture request: ${target.pathname}`);
        });
        const page = await reader.read(url);
        expect(page.text).toContain(paragraphs[0]);
        expect(page.text).toContain('LIBRARY-NOTICE-END-2026');
        expect(page.text).not.toContain('加载中');
        expect(page.contentHash).toBe(pageFingerprint(page.text));
        expect(page.collection).toEqual({
            version: 1,
            method: 'browser',
            complete: true,
            limitations: [],
        });
        expect(transport.mock.calls.map(([target]) => target.pathname)).toEqual([
            '/article',
            '/app.js',
        ]);
    });

    it('waits for a late article instead of accepting a long loading shell as complete', async () => {
        const explanation =
            ' This website provides information for registered readers. Please check privacy policies and service conditions before continuing.'.repeat(
                5,
            );
        const { reader, transport } = fixture(async (target) => {
            if (target.pathname === '/article')
                return response(
                    `<!doctype html><title>Library notice</title><main id="root"><p>加载中，请稍候……</p><div>${explanation}</div></main><script src="/app.js"></script>`,
                );
            if (target.pathname === '/app.js')
                return response(
                    `setTimeout(()=>{document.getElementById('root').innerHTML=${JSON.stringify(article)}},1500)`,
                    'application/javascript',
                );
            throw new Error(`Unexpected fixture request: ${target.pathname}`);
        });
        const page = await reader.read(url);
        expect(page.text).toContain(paragraphs[0]);
        expect(page.text).toContain('LIBRARY-NOTICE-END-2026');
        expect(page.text).not.toContain('加载中');
        expect(page.text).not.toContain('Please check privacy policies');
        expect(page.collection).toEqual({
            version: 1,
            method: 'browser',
            complete: true,
            limitations: [],
        });
        expect(transport.mock.calls.map(([target]) => target.pathname)).toEqual([
            '/article',
            '/app.js',
        ]);
    });

    it.each([
        ['loading', '<main>加载中</main>', { code: 'extraction_failed' }],
        [
            'challenge',
            '<title>安全验证</title><main>安全检测中</main>',
            { code: 'http', status: 403 },
        ],
    ] as const)(
        'rejects a %s shell instead of counting it as an evidence page',
        async (_kind, html, error) => {
            const { reader } = fixture(async () => response(`<!doctype html>${html}`));
            await expect(reader.read(url)).rejects.toMatchObject(error);
        },
    );

    it('accepts a legitimate five-character announcement', async () => {
        const { reader } = fixture(async () =>
            response('<!doctype html><article><p>今日闭馆。</p></article>'),
        );
        const page = await reader.read(url);
        expect(page.text).toBe('今日闭馆。');
        expect(page.truncated).toBe(false);
        expect(page.collection).toEqual({
            version: 1,
            method: 'html',
            complete: true,
            limitations: [],
        });
    });

    it.each([
        ['many', 'resource_limit'],
        ['large', 'resource_limit'],
        ['failed', 'resource_failure'],
        ['slow', 'render_timeout'],
    ] as const)(
        'preserves a rendered article when %s optional resources are limited',
        async (kind, limitation) => {
            let active = 0;
            let aborted = 0;
            const { reader, transport } = fixture(async (target, options) => {
                if (target.pathname === '/article')
                    return response(
                        '<!doctype html><main id="root">加载中</main><script src="/app.js"></script>',
                    );
                if (target.pathname === '/app.js') {
                    const requests = kind === 'many' ? 40 : 1;
                    return response(
                        `setTimeout(()=>{document.getElementById('root').innerHTML=${JSON.stringify(article)};for(let i=0;i<${requests};i++)fetch('/optional-'+i).catch(()=>{})},30)`,
                        'application/javascript',
                    );
                }
                if (!target.pathname.startsWith('/optional-'))
                    throw new Error('Unexpected resource');
                if (kind === 'large')
                    return response('x'.repeat(2 * 1024 * 1024 + 1), 'application/json');
                if (kind === 'failed')
                    throw new ConnectorError('network', 'Controlled optional resource failure');
                if (kind === 'slow') {
                    active++;
                    try {
                        await new Promise<void>((_resolve, reject) => {
                            const cancel = () => {
                                aborted++;
                                reject(new Error('cancelled'));
                            };
                            if (options.signal.aborted) cancel();
                            else options.signal.addEventListener('abort', cancel, { once: true });
                        });
                    } finally {
                        active--;
                    }
                }
                return response('{}', 'application/json');
            });
            const page = await reader.read(url);
            expect(page.text).toContain(paragraphs[0]);
            expect(page.text).toContain('LIBRARY-NOTICE-END-2026');
            expect(page.truncated).toBe(false);
            expect(page.contentHash).toBe(pageFingerprint(page.text));
            expect(page.collection).toMatchObject({
                version: 1,
                method: 'browser',
                complete: false,
            });
            expect(page.collection?.limitations).toContain(limitation);
            expect(transport.mock.calls.length).toBeLessThanOrEqual(32);
            expect(active).toBe(0);
            if (kind === 'slow') expect(aborted).toBe(1);
        },
    );

    it('rejects a loading shell when the required application resource fails', async () => {
        const { reader } = fixture(async (target) => {
            if (target.pathname === '/article')
                return response(
                    '<!doctype html><main>加载中</main><script src="/app.js"></script>',
                );
            throw new ConnectorError('network', 'Controlled required application failure');
        });
        await expect(reader.read(url)).rejects.toMatchObject({ code: 'extraction_failed' });
    });

    it.each(['signal', 'close'] as const)(
        'cancels a pending dynamic read via %s and drains resource work',
        async (mode) => {
            let started!: () => void;
            const resourceStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            let active = 0;
            let aborted = 0;
            let serveStatic = false;
            const { reader } = fixture(async (target, options) => {
                if (target.pathname === '/article')
                    return response(
                        serveStatic
                            ? article
                            : '<!doctype html><main>加载中</main><script src="/pending.js"></script>',
                    );
                active++;
                started();
                try {
                    await new Promise<void>((_resolve, reject) => {
                        const cancel = () => {
                            aborted++;
                            reject(new Error('cancelled'));
                        };
                        if (options.signal.aborted) cancel();
                        else options.signal.addEventListener('abort', cancel, { once: true });
                    });
                } finally {
                    active--;
                }
                throw new Error('unreachable');
            });
            const controller = new AbortController();
            const pending = reader.read(url, { signal: controller.signal });
            const settled = pending.then(
                () => null,
                (error: unknown) => error,
            );
            await Promise.race([
                resourceStarted,
                settled.then((error) => {
                    throw error ?? new Error('Resource did not start');
                }),
            ]);
            if (mode === 'signal') controller.abort();
            else await reader.close?.();
            expect(await settled).toMatchObject({ code: 'aborted' });
            if (mode === 'signal') {
                serveStatic = true;
                expect((await reader.read(url)).text).toContain('LIBRARY-NOTICE-END-2026');
            }
            await reader.close?.();
            expect(active).toBe(0);
            expect(aborted).toBe(1);
            await expect(reader.read(url)).rejects.toMatchObject({ code: 'aborted' });
        },
    );
});
