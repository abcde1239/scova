import { describe, expect, it } from 'vite-plus/test';
import { createConnectorBundle } from '@scova/connectors';
import { readSearchConfig } from '../src/app/search-config.ts';

describe('deployment-owned search configuration', () => {
    it('retains SearxNG by default even if paid API and model keys exist', () => {
        const options = readSearchConfig({
            SEARCH_API_KEY: 'search-key',
            MODEL_API_KEY: 'model-key',
        });
        expect(options.searchProvider).toBe('searxng');
        expect(options.searchApi).toBeUndefined();
    });

    it.each(['deepseek', 'perplexity'])(
        'maps explicit %s configuration into a live bundle',
        (protocol) => {
            const options = readSearchConfig({
                SEARCH_PROVIDER: 'api',
                SEARCH_API_PROTOCOL: protocol,
                SEARCH_API_KEY: 'search-key',
                SEARCH_API_BASE_URL: 'https://search.example/prefix',
                ...(protocol === 'perplexity' ? { SEARCH_API_SEARCH_TYPE: 'fast' } : {}),
            });
            expect(options.searchApi).toMatchObject({ protocol, apiKey: 'search-key' });
            expect(
                createConnectorBundle({ ...options, modelApiKey: 'model-key', model: 'model' })
                    .mode,
            ).toBe('live');
        },
    );

    it('preserves the Tavily opt-in independently of generic API settings', () => {
        expect(
            readSearchConfig({ SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'tavily-key' }),
        ).toMatchObject({
            searchProvider: 'tavily',
            tavilyApiKey: 'tavily-key',
        });
    });

    it('never inherits a model key when the search key is absent', () => {
        const options = readSearchConfig({
            SEARCH_PROVIDER: 'api',
            SEARCH_API_PROTOCOL: 'deepseek',
            MODEL_API_KEY: 'private-model-key',
        });
        expect(options.searchApi?.apiKey).toBe('');
        expect(() =>
            createConnectorBundle({ ...options, modelApiKey: 'private-model-key', model: 'model' }),
        ).toThrow();
    });

    it.each([
        { SEARCH_PROVIDER: 'unknown' },
        { SEARCH_PROVIDER: 'api' },
        { SEARCH_PROVIDER: 'api', SEARCH_API_PROTOCOL: 'unknown' },
        {
            SEARCH_PROVIDER: 'api',
            SEARCH_API_PROTOCOL: 'perplexity',
            SEARCH_API_SEARCH_TYPE: 'unknown',
        },
    ])('rejects unsupported deployment settings before an API call', (env) => {
        expect(() => readSearchConfig(env)).toThrow();
    });
});
