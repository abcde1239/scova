import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createConnectorBundle,
    createSafeHttpClient,
    type HttpTransport,
} from '../src/index.ts';
import { createFirecrawlReader, FIRECRAWL_EXTRACTION_VERSION } from '../src/reader/firecrawl.ts';

const source = 'https://source.example/article';
const final = 'https://publisher.example/article';
const markdown = '# Title\n\nVerifiable source text.';
const page = (metadata: Record<string, unknown> = {}) => ({
    success: true,
    data: {
        markdown,
        metadata: { sourceURL: source, url: final, title: 'Title', statusCode: 200, ...metadata },
    },
});

function fixture(payload: unknown = page(), status = 200) {
    const resolve = vi.fn(async (hostname: string) => [
        {
            address: hostname === 'private.example' ? '10.0.0.1' : '93.184.216.34',
            family: 4,
        },
    ]);
    const transport = vi.fn<HttpTransport>(async () => ({
        status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    }));
    const http = createSafeHttpClient({ resolve, transport });
    return {
        transport,
        resolve,
        http,
        reader: createFirecrawlReader({ apiKey: 'test-key', http, resolve }),
    };
}

describe('Firecrawl Reader', () => {
    it('posts a fresh Markdown-only request, maintains dispatch guards and records the final URL', async () => {
        const { reader, transport, resolve } = fixture();
        const beforeAttempt = vi.fn();
        const beforeDispatch = vi.fn();
        const originalUrl = `${source}?utm_source=test`;
        const result = await reader.read(originalUrl, {
            beforeAttempt,
            beforeDispatch,
            timeoutMs: 4000,
        });
        const [endpoint, request] = transport.mock.calls[0]!;
        expect(endpoint.href).toBe('https://api.firecrawl.dev/v2/scrape');
        expect(request.method).toBe('POST');
        expect(request.headers).toMatchObject({ authorization: 'Bearer test-key' });
        expect(JSON.parse(request.body!)).toEqual({
            url: source,
            formats: ['markdown'],
            onlyMainContent: true,
            maxAge: 0,
            storeInCache: false,
            timeout: 4000,
        });
        expect(beforeAttempt).toHaveBeenCalledExactlyOnceWith('read');
        expect(beforeDispatch).toHaveBeenCalledTimes(1);
        expect(resolve.mock.calls.map(([host]) => host)).toEqual([
            'source.example',
            'api.firecrawl.dev',
            'publisher.example',
        ]);
        expect(result).toMatchObject({
            originalUrl,
            url: final,
            fetchedUrl: final,
            text: markdown,
            title: 'Title',
            untrusted: true,
            truncated: false,
            extractionVersion: FIRECRAWL_EXTRACTION_VERSION,
            contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
        });
        expect(result).not.toHaveProperty('publication');
    });

    it.each(['http://127.0.0.1/secret', 'https://private.example/secret'])(
        'rejects a non-public target before dispatch: %s',
        async (url) => {
            const { reader, transport } = fixture();
            await expect(reader.read(url)).rejects.toMatchObject({ code: 'unsafe_url' });
            expect(transport).not.toHaveBeenCalled();
        },
    );

    it.each([
        [page({ sourceURL: 'https://other.example/article' }), 'invalid_response'],
        [page({ url: 'https://private.example/redirect' }), 'unsafe_url'],
        [page({ statusCode: 403 }), 'extraction_failed'],
        [{ success: true, data: { ...page().data, markdown: '  ' } }, 'extraction_failed'],
    ])('rejects mismatched sources, unsafe redirects and unusable extracts', async (body, code) => {
        const { reader, transport } = fixture(body);
        await expect(reader.read(source)).rejects.toMatchObject({ code });
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it('reports failed target DNS as a page read failure before dispatch', async () => {
        const { reader, transport, resolve } = fixture();
        resolve.mockRejectedValueOnce(new Error('ENOTFOUND'));
        await expect(reader.read(source)).rejects.toMatchObject({ code: 'network' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('accepts matching source metadata when the provider omits the final URL', async () => {
        const { reader } = fixture(page({ url: undefined }));
        expect(await reader.read(source)).toMatchObject({ url: source, fetchedUrl: source });
    });

    it('does not send a request after the dispatch guard rejects', async () => {
        const { reader, transport } = fixture();
        const stopped = new ConnectorError('aborted', 'lease ended');
        await expect(
            reader.read(source, {
                beforeDispatch: async () => {
                    throw stopped;
                },
            }),
        ).rejects.toBe(stopped);
        expect(transport).not.toHaveBeenCalled();
    });

    it('does not retry a paid POST or dispatch an aborted read', async () => {
        const { reader, transport } = fixture({}, 429);
        await expect(reader.read(source)).rejects.toMatchObject({ code: 'http', status: 429 });
        expect(transport).toHaveBeenCalledTimes(1);
        await expect(reader.read(source, { signal: AbortSignal.abort() })).rejects.toMatchObject({
            code: 'aborted',
        });
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it('routes only the SearXNG bundle to Firecrawl when a key is configured', async () => {
        const { http, transport } = fixture();
        const options = {
            modelApiKey: 'model-key',
            model: 'model',
            firecrawlApiKey: 'firecrawl-key',
            http,
        };
        const managed = createConnectorBundle({ ...options, searchProvider: 'searxng' });
        expect(managed.searchProvider).toBe('searxng');
        const routeUrl = 'https://1.1.1.1/article';
        transport.mockResolvedValueOnce({
            status: 200,
            headers: {},
            body: JSON.stringify(page({ sourceURL: routeUrl, url: routeUrl })),
        });
        expect(await managed.reader.read(routeUrl)).toMatchObject({
            extractionVersion: FIRECRAWL_EXTRACTION_VERSION,
        });
        expect(transport.mock.calls[0]![0].href).toBe('https://api.firecrawl.dev/v2/scrape');
        const tavily = createConnectorBundle({
            ...options,
            searchProvider: 'api',
            searchApi: { protocol: 'tavily', apiKey: 'tavily-key' },
        });
        transport.mockResolvedValueOnce({
            status: 200,
            headers: {},
            body: JSON.stringify({
                results: [{ url: source, raw_content: markdown }],
                failed_results: [],
            }),
        });
        expect(await tavily.reader.read(source)).toMatchObject({
            extractionVersion: 'search-api/tavily/fetch-v1',
        });
        expect(transport.mock.calls[1]![0].href).toBe('https://api.tavily.com/extract');
    });
});
