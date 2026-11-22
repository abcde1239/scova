import { describe, expect, it } from 'vite-plus/test';
import { createConnectorBundle } from '@scova/connectors';
import {
    effectiveSearchConfig,
    accountSearchConfig,
} from '../../server/src/service/execution/search-config.ts';
import { sealCredential } from '@scova/shared/credentials';

const api = {
    protocol: 'tavily' as const,
    baseUrl: 'https://api.tavily.com',
    apiKey: 'account-search-key',
    contentMode: 'prefer_api' as const,
};
const deployment: NodeJS.ProcessEnv = {
    SEARCH_PROVIDER: 'api',
    SEARCH_API_PROTOCOL: 'deepseek',
    SEARCH_API_KEY: 'deployment-key',
    TAVILY_API_KEY: 'deployment-tavily-key',
    MODEL_API_KEY: 'model-key',
    SEARXNG_BASE_URL: 'http://searxng:8080',
};

describe('account-owned search configuration', () => {
    it('opens only the independent search key bound to its account and search record', () => {
        const key = 'ac'.repeat(32);
        const saved = {
            id: 'search-record',
            defaultMode: 'api' as const,
            ...api,
            encryptedApiKey: sealCredential(api.apiKey, 'owner', 'search-record', key),
        };
        expect(
            accountSearchConfig({ ...deployment, AGENT_CREDENTIAL_KEY: key }, saved, 'owner'),
        ).toMatchObject({ searchProvider: 'api', searchApi: api });
        expect(() =>
            accountSearchConfig({ AGENT_CREDENTIAL_KEY: key }, saved, 'other-account'),
        ).toThrow();
        expect(() =>
            accountSearchConfig(
                { AGENT_CREDENTIAL_KEY: key },
                { ...saved, id: 'model-record' },
                'owner',
            ),
        ).toThrow();
        expect(
            accountSearchConfig(
                {},
                { ...saved, encryptedApiKey: 'unreadable' },
                'owner',
                'searxng',
            ),
        ).toMatchObject({ searchProvider: 'searxng', modelSearch: 'disabled' });
    });
    it('defaults to built-in search without reading deployment search credentials', () => {
        expect(effectiveSearchConfig(deployment, null)).toMatchObject({
            searchProvider: 'searxng',
            modelSearch: 'disabled',
        });
        expect(effectiveSearchConfig({}, null)).toMatchObject({ searchProvider: 'searxng' });
        expect(() => effectiveSearchConfig(deployment, null, 'api')).toThrow(
            expect.objectContaining({ failureCode: 'SEARCH_API_NOT_CONFIGURED' }),
        );
        expect(() =>
            effectiveSearchConfig(deployment, { defaultMode: 'searxng' }, 'api'),
        ).toThrow();
    });
    it('reports an unreadable independent search key without changing search services', () => {
        expect(() =>
            accountSearchConfig(
                {},
                {
                    id: 'search-record',
                    defaultMode: 'api',
                    ...api,
                    encryptedApiKey: 'invalid',
                },
                'owner',
            ),
        ).toThrow(expect.objectContaining({ failureCode: 'SEARCH_CREDENTIAL_INVALID' }));
    });
    it('honors the independent account API and disables model-native search', () => {
        expect(effectiveSearchConfig(deployment, { defaultMode: 'api', searchApi: api })).toEqual({
            searchProvider: 'api',
            searchApi: api,
            modelSearch: 'disabled',
        });
    });
    it('normalizes stored Reader policy to API reading without changing credentials', () => {
        const key = 'ac'.repeat(32);
        expect(
            accountSearchConfig(
                { AGENT_CREDENTIAL_KEY: key },
                {
                    id: 'search-record',
                    defaultMode: 'api',
                    ...api,
                    contentMode: 'reader',
                    encryptedApiKey: sealCredential(api.apiKey, 'owner', 'search-record', key),
                },
                'owner',
            ),
        ).toMatchObject({ searchProvider: 'api', searchApi: api });
    });
    it('uses explicit account built-in preference even with stored API credentials', () => {
        expect(
            effectiveSearchConfig(deployment, { defaultMode: 'searxng', searchApi: api }),
        ).toEqual({
            searchProvider: 'searxng',
            searxngBaseUrl: 'http://searxng:8080',
            modelSearch: 'disabled',
        });
    });
    it('lets a task or run explicitly override either account preference', () => {
        expect(
            effectiveSearchConfig(deployment, { defaultMode: 'searxng', searchApi: api }, 'api'),
        ).toMatchObject({ searchProvider: 'api', searchApi: api });
        expect(effectiveSearchConfig(deployment, null, 'searxng')).toMatchObject({
            searchProvider: 'searxng',
        });
        expect(
            effectiveSearchConfig(deployment, { defaultMode: 'api', searchApi: api }, 'searxng'),
        ).toMatchObject({ searchProvider: 'searxng', modelSearch: 'disabled' });
    });
    it('creates API search and reading tools for any execution model', () => {
        const search = effectiveSearchConfig(deployment, { defaultMode: 'api', searchApi: api });
        for (const modelProtocol of ['openai_json', 'anthropic_messages', 'gemini'] as const) {
            const bundle = createConnectorBundle({
                modelApiKey: 'model-key',
                model: 'example',
                modelProtocol,
                ...search,
            });
            expect(bundle.mode).toBe('live');
            expect(bundle.search.tokenReservation).toBeUndefined();
            expect(bundle.reader).toBeDefined();
            expect(bundle.reader).toBe(bundle.search);
        }
        expect(() =>
            effectiveSearchConfig(deployment, {
                defaultMode: 'api',
                searchApi: { ...api, apiKey: '' },
            }),
        ).toThrow();
    });
    it('rejects old Perplexity configurations rather than using local reading', () => {
        expect(() =>
            effectiveSearchConfig(
                {},
                { defaultMode: 'api', searchApi: { ...api, protocol: 'perplexity' } },
            ),
        ).toThrow(expect.objectContaining({ failureCode: 'SEARCH_API_READING_UNSUPPORTED' }));
    });
});
