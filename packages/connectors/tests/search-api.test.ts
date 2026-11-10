import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createConnectorBundle,
    createSafeHttpClient,
    createSearchApi,
    type HttpTransport,
    type SearchApiOptions,
} from '../src/index.ts';

const item = (url = 'https://source.example/article') => ({
    url,
    title: 'Published article',
    snippet: 'A candidate excerpt, not collected evidence.',
    content: 'DO NOT PROMOTE PROVIDER CONTENT TO EVIDENCE',
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
});
function fixture(
    protocol: SearchApiOptions['protocol'] = 'deepseek',
    payload: unknown = { results: [item()] },
    config: Partial<SearchApiOptions> = {},
) {
    const transport = vi.fn<HttpTransport>(async () => json(payload));
    const http = createSafeHttpClient({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport,
    });
    const options = { protocol, apiKey: 'fixture-search-key', http, ...config };
    return { source: createSearchApi(options), transport, options, http };
}

describe('raw search API compatibility', () => {
    it.each(['deepseek', 'perplexity'] as const)(
        'sends the documented %s request and returns only candidate snippets',
        async (protocol) => {
            const { source, transport } = fixture(protocol);
            const beforeAttempt = vi.fn();
            const result = await source.search('quoted query site:source.example', {
                beforeAttempt,
            });
            const [url, options] = transport.mock.calls[0];
            expect(url.toString()).toBe(
                protocol === 'deepseek'
                    ? 'https://api.deepseek.com/v1/tools/search'
                    : 'https://api.perplexity.ai/search',
            );
            expect(options.method).toBe('POST');
            expect(options.headers.authorization).toBe('Bearer fixture-search-key');
            expect(JSON.parse(options.body!)).toEqual(
                protocol === 'deepseek'
                    ? { query: result.query, count: 5, need_content: false }
                    : { query: result.query, max_results: 5, search_type: 'web' },
            );
            expect(beforeAttempt).toHaveBeenCalledExactlyOnceWith('search');
            expect(result).toMatchObject({
                provider: protocol,
                mode: 'live',
                results: [{ kind: 'search_snippet', snippet: item().snippet }],
                coverage: { complete: true, totalResults: null, returnedResults: 1 },
            });
            expect(JSON.stringify(result)).not.toContain(item().content);
        },
    );

    it('preserves a deployment path prefix and explicitly selects Perplexity fast search', async () => {
        const { source, transport } = fixture('perplexity', undefined, {
            baseUrl: 'https://search.example/proxy/v1/',
            searchType: 'fast',
        });
        await source.search('query');
        expect(transport.mock.calls[0][0].toString()).toBe(
            'https://search.example/proxy/v1/search',
        );
        expect(JSON.parse(transport.mock.calls[0][1].body!)).toMatchObject({ search_type: 'fast' });
    });

    it.each([
        'http://search.example',
        'https://user:secret@search.example',
        'https://search.example?key=secret',
        'https://search.example#secret',
        'https://127.0.0.1',
        'https://search.internal',
        'https://search.example:8443',
        'not-a-url-secret',
    ])('rejects unsafe or ambiguous deployment endpoints without leaking them: %s', (baseUrl) => {
        expect(() => fixture('deepseek', undefined, { baseUrl })).toThrow(ConnectorError);
        try {
            fixture('deepseek', undefined, { baseUrl });
        } catch (error) {
            expect((error as Error).message).not.toContain('secret');
        }
    });

    it('keeps the configured host even when its path starts with two slashes', async () => {
        const { source, transport } = fixture('deepseek', undefined, {
            baseUrl: 'https://search.example//other.example',
        });
        await source.search('query');
        expect(transport.mock.calls[0][0].hostname).toBe('search.example');
    });

    it('rejects private DNS results before transport', async () => {
        const { options, transport } = fixture();
        const http = createSafeHttpClient({
            resolve: async () => [{ address: '10.0.0.1', family: 4 }],
            transport,
        });
        await expect(createSearchApi({ ...options, http }).search('query')).rejects.toMatchObject({
            code: 'unsafe_url',
        });
        expect(transport).not.toHaveBeenCalled();
    });

    it('does not follow redirects or forward API credentials to a new host', async () => {
        const { source, transport } = fixture();
        transport.mockResolvedValue(json({}, 302, { location: 'https://other.example/search' }));
        await expect(source.search('query')).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it.each([401, 402, 403, 429, 503])('does not automatically replay HTTP %i', async (status) => {
        const { source, transport } = fixture();
        transport.mockResolvedValue(json({ error: 'PRIVATE_KEY_OR_UPSTREAM_PROMPT' }, status));
        await expect(source.search('query')).rejects.toMatchObject({ code: 'http', status });
        expect(transport).toHaveBeenCalledTimes(1);
        await expect(source.search('query')).rejects.not.toThrow('PRIVATE_KEY');
    });

    it('reserves every explicitly enabled retry and retains the failure for accounting', async () => {
        const { source, transport } = fixture('deepseek', undefined, {
            maxAttempts: 2,
            retryDelayMs: 0,
        });
        transport.mockResolvedValueOnce(json({}, 503));
        const beforeAttempt = vi.fn();
        await source.search('query', { beforeAttempt });
        expect(beforeAttempt).toHaveBeenNthCalledWith(1, 'search');
        expect(beforeAttempt).toHaveBeenNthCalledWith(
            2,
            'search',
            expect.objectContaining({ status: 503 }),
        );
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it('does not dispatch a retry after the caller refuses its budget reservation', async () => {
        const { source, transport } = fixture('deepseek', undefined, {
            maxAttempts: 2,
            retryDelayMs: 0,
        });
        transport.mockResolvedValueOnce(json({}, 503));
        const beforeAttempt = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(
                new ConnectorError('budget_exceeded', 'No remaining search budget'),
            );
        await expect(source.search('query', { beforeAttempt })).rejects.toMatchObject({
            code: 'budget_exceeded',
        });
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it('honors cancellation during reservation before any network dispatch', async () => {
        const { source, transport } = fixture();
        const controller = new AbortController();
        await expect(
            source.search('query', {
                signal: controller.signal,
                beforeAttempt: () => controller.abort(),
            }),
        ).rejects.toMatchObject({ code: 'aborted' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('cancels an in-flight request using the caller deadline', async () => {
        const { source, transport } = fixture();
        transport.mockImplementation(async (_url, options) => {
            await new Promise<void>((_resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                    once: true,
                });
            });
            return json({});
        });
        await expect(source.search('query', { timeoutMs: 30 })).rejects.toMatchObject({
            code: 'timeout',
        });
        expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it.each(['', ' '.repeat(3), 'a'.repeat(129)])(
        'rejects unsupported DeepSeek queries unchanged',
        async (query) => {
            const { source, transport } = fixture();
            await expect(source.search(query)).rejects.toMatchObject({ code: 'configuration' });
            expect(transport).not.toHaveBeenCalled();
        },
    );

    it('counts DeepSeek Unicode code points instead of UTF-16 units', async () => {
        const { source, transport } = fixture();
        await source.search('😀'.repeat(128));
        expect(JSON.parse(transport.mock.calls[0][1].body!).query).toBe('😀'.repeat(128));
    });

    it.each([{}, { answer: 'An LLM answer with citations' }, { results: null }])(
        'rejects model answers and malformed envelopes rather than inventing results',
        async (payload) => {
            const { source } = fixture('deepseek', payload);
            await expect(source.search('query')).rejects.toMatchObject({
                code: 'invalid_response',
            });
        },
    );

    it('filters unsafe, malformed and duplicate URLs and records bounded coverage', async () => {
        const { source } = fixture('deepseek', {
            results: [
                item(),
                item('https://source.example/article?utm_source=x'),
                item('http://127.0.0.1/'),
                null,
            ],
        });
        const result = await source.search('query');
        expect(result.results).toHaveLength(1);
        expect(result.coverage).toMatchObject({
            complete: false,
            receivedResults: 4,
            discardedResults: 3,
        });
        expect(result.coverage.gaps).toHaveLength(1);
    });

    it('reports truncation rather than claiming that all candidates were returned', async () => {
        const { source } = fixture('deepseek', {
            results: Array.from({ length: 8 }, (_, i) => item(`https://source.example/${i}`)),
        });
        const result = await source.search('query');
        expect(result.results).toHaveLength(5);
        expect(result.coverage).toMatchObject({
            complete: false,
            truncated: true,
            receivedResults: 8,
        });
    });

    it('accepts a genuine empty result set without fabricating sources', async () => {
        const { source } = fixture('perplexity', { results: [] });
        expect((await source.search('query')).results).toEqual([]);
    });

    it('only activates a paid adapter through explicit bundle configuration', async () => {
        const { options, transport, http } = fixture();
        const bundle = createConnectorBundle({
            searchProvider: 'api',
            searchApi: options,
            managedSearch: true,
            modelApiKey: 'separate-model-key',
            model: 'fixture-model',
            http,
        });
        expect(bundle.mode).toBe('live');
        expect((await bundle.search.search('query')).provider).toBe('deepseek');
        expect(JSON.parse(transport.mock.calls[0][1].body!).count).toBe(10);
        expect(transport.mock.calls[0][1].headers.authorization).toBe('Bearer fixture-search-key');
        expect(() => createConnectorBundle({ searchProvider: 'api' })).toThrow(ConnectorError);
        const defaultBundle = createConnectorBundle({
            searchApi: options,
            modelApiKey: 'separate-model-key',
            model: 'fixture-model',
            http,
        });
        expect(defaultBundle.mode).toBe('live');
        transport.mockClear();
        // Creating a default bundle must not call a paid API or require its configuration.
        expect(transport).not.toHaveBeenCalled();
    });
});
