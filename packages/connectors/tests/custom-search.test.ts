import { describe, expect, it, vi } from 'vite-plus/test';
import {
    createCustomJsonSearch,
    createConnectorBundle,
    createSafeHttpClient,
    validateCustomSearchTemplate,
    type CustomJsonSearchTemplate,
    type HttpTransport,
} from '../src/index.ts';

const template: CustomJsonSearchTemplate = {
    method: 'GET',
    languageMap: { zh: 'zh-hans' },
    auth: { type: 'header', headerName: 'X-Subscription-Token' },
    request: { q: '{{query}}', count: '{{count}}', search_lang: '{{language}}' },
    response: {
        resultsPath: 'web.results',
        urlPath: 'url',
        titlePath: 'title',
        snippetPath: 'description',
    },
};
const item = (url = 'https://source.example/article') => ({
    url,
    title: 'A publication',
    description: 'Candidate only',
    content: 'Not evidence',
});
function fixture(
    payload: unknown = { web: { results: [item()] } },
    changes: Partial<CustomJsonSearchTemplate> = {},
) {
    const transport = vi.fn<HttpTransport>(async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    }));
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const http = createSafeHttpClient({ resolve, transport });
    const custom = { ...template, ...changes };
    const options = {
        baseUrl: 'https://search.example/custom',
        apiKey: 'separate-secret',
        custom,
        http,
    };
    return { source: createCustomJsonSearch(options), transport, resolve, http, options };
}

describe('custom search finite JSON protocol', () => {
    it.each(['GET', 'POST'] as const)(
        'preserves the complete endpoint trailing slash for %s without redirecting',
        async (method) => {
            const { options, transport } = fixture(undefined, { method });
            const source = createCustomJsonSearch({
                ...options,
                baseUrl: 'https://search.example/custom/',
            });
            await source.search('Agent');
            const [url, request] = transport.mock.calls[0];
            expect(url.pathname).toBe('/custom/');
            expect(request.method).toBe(method);
            expect(transport).toHaveBeenCalledTimes(1);
        },
    );
    it('sends escaped GET parameters through the real pinned transport, maps language and never exposes content as evidence', async () => {
        const { source, transport, resolve } = fixture();
        const beforeAttempt = vi.fn(),
            beforeDispatch = vi.fn();
        const query = '原名 "x" & q=bad {{count}}';
        const response = await source.search(query, {
            language: 'zh',
            beforeAttempt,
            beforeDispatch,
        });
        expect(resolve).toHaveBeenCalledWith('search.example', expect.any(AbortSignal));
        expect(beforeAttempt).toHaveBeenCalledTimes(1);
        expect(beforeDispatch).toHaveBeenCalledTimes(1);
        const [url, request] = transport.mock.calls[0];
        expect([...url.searchParams]).toEqual([
            ['count', '5'],
            ['q', query],
            ['search_lang', 'zh-hans'],
        ]);
        expect(request.address.address).toBe('93.184.216.34');
        expect(request.headers['X-Subscription-Token']).toBe('separate-secret');
        expect(response.results[0]).not.toHaveProperty('page');
        expect(response.provider).toBe('custom_json');
        expect(JSON.stringify(response)).not.toContain('separate-secret');
    });
    it('omits unavailable optional language instead of sending an empty or literal token', async () => {
        const { source, transport } = fixture();
        await source.search('Agent');
        expect(transport.mock.calls[0][0].searchParams.has('search_lang')).toBe(false);
    });
    it('rejects an optional-language field as the only query field before any request', () => {
        const { options, transport } = fixture();
        expect(() =>
            createCustomJsonSearch({
                ...options,
                custom: { ...template, request: { q: '{{query}} {{language}}' } },
            }),
        ).toThrow();
        expect(transport).not.toHaveBeenCalled();
    });
    it('builds JSON POST as fields, retains count number and never re-expands tokens inside a query', async () => {
        const { source, transport } = fixture(undefined, {
            method: 'POST',
            auth: { type: 'bearer' },
            request: {
                query: '{{query}}',
                count: '{{count}}',
                lang: '{{language}}',
                enabled: true,
            },
        });
        await source.search('quote " {{language}}', { language: 'ja' });
        const [url, request] = transport.mock.calls[0];
        expect(url.search).toBe('');
        expect(request.headers.authorization).toBe('Bearer separate-secret');
        expect(JSON.parse(request.body!)).toEqual({
            query: 'quote " {{language}}',
            count: 5,
            lang: 'ja',
            enabled: true,
        });
    });
    it('snapshots caller templates and supports bounded array-index paths', async () => {
        const custom = structuredClone(template);
        custom.response = {
            resultsPath: 'payload[0].results',
            urlPath: 'url',
            titlePath: 'title',
            snippetPath: 'description',
        };
        const { source, transport } = fixture({ payload: [{ results: [item()] }] }, custom);
        custom.request.q = 'changed';
        expect((await source.search('original')).results).toHaveLength(1);
        expect(transport.mock.calls[0][0].searchParams.get('q')).toBe('original');
    });
    it('filters unsafe and duplicate candidates, bounds output and preserves partial coverage', async () => {
        const { source } = fixture({
            web: {
                results: [
                    item(),
                    item(),
                    item('http://127.0.0.1/'),
                    ...Array.from({ length: 7 }, (_, i) => item(`https://source.example/${i}`)),
                ],
            },
        });
        const response = await source.search('Agent');
        expect(response.results).toHaveLength(5);
        expect(response.coverage).toMatchObject({
            complete: false,
            discardedResults: 2,
            truncated: true,
            receivedResults: 10,
        });
    });
    it.each([{}, { answer: 'Generated answer' }, { web: { results: null } }])(
        'rejects missing result arrays',
        async (payload) => {
            await expect(fixture(payload).source.search('Agent')).rejects.toMatchObject({
                code: 'invalid_response',
            });
        },
    );
    it('accepts an empty result array without making evidence', async () => {
        const result = await fixture({ web: { results: [] } }).source.search('Agent');
        expect(result.results).toEqual([]);
        expect(result.coverage.complete).toBe(true);
    });
    it.each([
        'https://127.0.0.1/search',
        'http://search.example/search',
        'https://user:secret@search.example/search',
        'https://search.example/search?key=x',
        'https://search.example/search#fragment',
    ])('rejects unsafe or secret-bearing endpoint %s before dispatch', (baseUrl) => {
        const { options, transport } = fixture();
        expect(() => createCustomJsonSearch({ ...options, baseUrl })).toThrow();
        expect(transport).not.toHaveBeenCalled();
    });
    it('rejects private DNS addresses at the real client and never dispatches', async () => {
        const { options, transport } = fixture();
        const http = createSafeHttpClient({
            resolve: async () => [{ address: '127.0.0.1', family: 4 }],
            transport,
        });
        await expect(
            createCustomJsonSearch({ ...options, http }).search('Agent'),
        ).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('does not follow redirects or replay paid calls', async () => {
        const { source, transport } = fixture();
        transport.mockResolvedValue({
            status: 302,
            headers: { location: 'https://other.example/secret' },
            body: '',
        });
        await expect(source.search('Agent')).rejects.toThrow();
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('preserves cancellation and dispatch budget guards', async () => {
        const { source, transport } = fixture();
        const controller = new AbortController();
        controller.abort();
        await expect(source.search('Agent', { signal: controller.signal })).rejects.toMatchObject({
            code: 'aborted',
        });
        await expect(
            source.search('Agent', {
                beforeDispatch: async () => {
                    throw new Error('budget guard');
                },
            }),
        ).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
    });
    it.each([
        'Host',
        'Cookie',
        'Content-Type',
        'X-Forwarded-For',
        'Sec-Fetch-Site',
        'Authorization',
        'X-Key\r\nInjected',
    ])('rejects privileged authentication header %s', (headerName) => {
        expect(() =>
            validateCustomSearchTemplate({ ...template, auth: { type: 'header', headerName } }),
        ).toThrow();
    });
    it.each([
        '__proto__.results',
        'web.constructor.results',
        'web[1000].results',
        '$..results',
        'web.*',
        'web[0].prototype',
    ])('rejects executable/prototype/unbounded path %s', (resultsPath) => {
        expect(() =>
            validateCustomSearchTemplate({
                ...template,
                response: { ...template.response, resultsPath },
            }),
        ).toThrow();
    });
    it.each([
        { q: '{{unknown}}' },
        { q: '{{query}}', api_key: 'plaintext-secret' },
        { q: '{{query}}', nested: {} },
        { q: 'constant without query' },
    ])('rejects unsafe request templates', (request) => {
        expect(() => validateCustomSearchTemplate({ ...template, request })).toThrow();
    });
    it('activates local Reader only for an explicit custom combination, preserving existing API-only behavior', () => {
        const { options, http } = fixture();
        const bundle = createConnectorBundle({
            searchProvider: 'api',
            searchApi: { ...options, protocol: 'custom_json', contentMode: 'reader' },
            modelApiKey: 'model-key',
            model: 'fixture',
            http,
        });
        expect(bundle.mode).toBe('live');
        expect(bundle.providerReads).toBe(false);
        expect(bundle.reader).not.toBe(bundle.search);
        expect(() =>
            createConnectorBundle({
                searchProvider: 'api',
                searchApi: { ...options, protocol: 'custom_json', contentMode: 'prefer_api' },
                modelApiKey: 'model-key',
                model: 'fixture',
                http,
            }),
        ).toThrow();
        const legacy = createConnectorBundle({
            searchProvider: 'api',
            searchApi: { protocol: 'deepseek', apiKey: 'key', contentMode: 'reader' },
            modelApiKey: 'model-key',
            model: 'fixture',
            http,
        });
        expect(legacy.reader).toBe(legacy.search);
    });
});
