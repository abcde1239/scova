import { Ajv } from 'ajv';
import type { SafeHttpClient } from './http/index.ts';
import { createTavilySearch } from './search/tavily.ts';
import { createModelProvider } from './model/provider.ts';
import { pageFingerprint } from './reader/http-reader.ts';
import { createPageReader } from './reader/browser.ts';
import { createFirecrawlReader } from './reader/firecrawl.ts';
import { createSearxngSearch } from './search/searxng.ts';
import { createSearchApi, type SearchApiOptions } from './search/api.ts';
import { createCustomJsonSearch } from './search/custom.ts';
import { ConnectorError } from './types.ts';
import type { ModelProtocol } from './model/protocol.ts';
import type {
    CallContext,
    ModelProvider,
    PageReader,
    SearchProvider,
    StructuredInput,
} from './types.ts';

export const DEMO_URL = 'https://demo.scova.invalid/example';
const DEMO_TEXT = '演示资料：这是固定的 Scova 功能示例，不是从互联网采集的事实。';

export interface ConnectorBundle {
    mode: 'live' | 'demo';
    searchProvider?: 'searxng' | 'api';
    /** Explicit custom search + local Reader, independent from the search transport. */
    providerReads?: boolean;
    /** Opaque frozen configuration identity for custom search/read tool operations. */
    searchIdentity?: string;
    reason?: string;
    search: SearchProvider;
    reader: PageReader;
    model: ModelProvider;
}

export function createConnectorBundle(
    options: {
        tavilyApiKey?: string;
        searchProvider?: 'searxng' | 'tavily' | 'api';
        searchApi?: SearchApiOptions;
        searxngBaseUrl?: string;
        firecrawlApiKey?: string;
        managedSearch?: boolean;
        modelApiKey?: string;
        model?: string;
        modelBaseUrl?: string;
        modelProtocol?: ModelProtocol;
        http?: SafeHttpClient;
    } = {},
): ConnectorBundle {
    const searchProvider = options.searchProvider ?? 'searxng';
    if (!['searxng', 'tavily', 'api'].includes(searchProvider))
        throw new ConnectorError('configuration', '搜索服务选项无效');
    const searchApi = searchProvider === 'api' ? options.searchApi : undefined;
    if (searchProvider === 'api' && !searchApi)
        throw new ConnectorError('configuration', '搜索 API 未配置');
    if (searchApi?.protocol === 'perplexity')
        throw new ConnectorError(
            'configuration',
            'Perplexity Search 暂不支持独立网页读取，请选择 DeepSeek 或 Tavily',
        );
    let customSearch: SearchProvider | undefined;
    let apiSearch: (SearchProvider & PageReader) | undefined;
    if (searchApi) {
        const apiOptions = {
            ...searchApi,
            http: searchApi.http ?? options.http,
            maxResults: options.managedSearch ? 10 : searchApi.maxResults,
        };
        if (searchApi.protocol === 'custom_json') {
            if (searchApi.contentMode !== 'reader' || !searchApi.custom || !searchApi.baseUrl)
                throw new ConnectorError(
                    'configuration',
                    '自定义 JSON 搜索须明确选择本地 Reader 并填写模板',
                );
            customSearch = createCustomJsonSearch({
                ...apiOptions,
                baseUrl: searchApi.baseUrl,
                custom: searchApi.custom,
            });
        } else {
            apiSearch = createSearchApi(apiOptions);
        }
    }
    if (
        (searchProvider === 'searxng' ||
            apiSearch ||
            customSearch ||
            options.tavilyApiKey?.trim()) &&
        options.modelApiKey?.trim() &&
        options.model?.trim()
    ) {
        return {
            mode: 'live',
            searchProvider:
                apiSearch || customSearch
                    ? 'api'
                    : searchProvider === 'searxng'
                      ? 'searxng'
                      : undefined,
            ...(customSearch ? { providerReads: false } : {}),
            search:
                apiSearch ??
                customSearch ??
                (searchProvider === 'searxng'
                    ? createSearxngSearch({
                          baseUrl: options.searxngBaseUrl,
                          http: options.http,
                          maxResults: options.managedSearch ? 10 : undefined,
                          maxAttempts: options.managedSearch ? 1 : undefined,
                      })
                    : createTavilySearch({ apiKey: options.tavilyApiKey!, http: options.http })),
            reader:
                apiSearch ??
                (searchProvider === 'searxng' && options.firecrawlApiKey?.trim()
                    ? createFirecrawlReader({ apiKey: options.firecrawlApiKey, http: options.http })
                    : createPageReader({ http: options.http })),
            model: createModelProvider({
                apiKey: options.modelApiKey,
                model: options.model,
                baseUrl: options.modelBaseUrl,
                protocol: options.modelProtocol,
                http: options.http,
            }),
        };
    }
    const ajv = new Ajv({ strict: true });
    return {
        mode: 'demo',
        reason: '缺少搜索或模型配置，整个管线使用固定演示资料。',
        search: {
            async search(query, context = {}) {
                if (context.signal?.aborted) throw new ConnectorError('aborted', '调用已取消');
                await context.beforeAttempt?.('search');
                if (context.signal?.aborted) throw new ConnectorError('aborted', '调用已取消');
                return {
                    kind: 'search_results',
                    mode: 'demo',
                    provider: 'demo',
                    query,
                    searchedAt: '2026-01-01T00:00:00.000Z',
                    results: [
                        {
                            kind: 'search_snippet',
                            originalUrl: DEMO_URL,
                            url: DEMO_URL,
                            title: 'Scova 演示资料',
                            snippet: DEMO_TEXT,
                        },
                    ],
                    coverage: {
                        complete: true,
                        gaps: [],
                        unresponsiveEngines: [],
                        receivedResults: 1,
                        returnedResults: 1,
                        discardedResults: 0,
                        totalResults: 1,
                        truncated: false,
                    },
                };
            },
        },
        reader: {
            async read(url, context = {}) {
                if (context.signal?.aborted) throw new ConnectorError('aborted', '调用已取消');
                if (url !== DEMO_URL)
                    throw new ConnectorError('configuration', '演示模式只能读取固定演示来源');
                await context.beforeAttempt?.('read');
                if (context.signal?.aborted) throw new ConnectorError('aborted', '调用已取消');
                return {
                    kind: 'read_page',
                    mode: 'demo',
                    originalUrl: DEMO_URL,
                    fetchedUrl: DEMO_URL,
                    url: DEMO_URL,
                    title: 'Scova 演示资料',
                    text: DEMO_TEXT,
                    contentHash: pageFingerprint(DEMO_TEXT),
                    extractionVersion: 'scova-demo-v1',
                    collectedAt: '2026-01-01T00:00:00.000Z',
                    truncated: false,
                    untrusted: true,
                };
            },
        },
        model: {
            async generateStructured<T>(input: StructuredInput, context: CallContext = {}) {
                if (context.signal?.aborted) throw new ConnectorError('aborted', '调用已取消');
                const data = { summary: DEMO_TEXT, sourceUrls: [DEMO_URL], mode: 'demo' };
                let valid: boolean;
                try {
                    valid = ajv.validate(input.schema, data) as boolean;
                } catch {
                    throw new ConnectorError('configuration', '演示模型 schema 无效');
                }
                if (!valid)
                    throw new ConnectorError('configuration', '固定演示输出不符合所请求 schema');
                await context.beforeAttempt?.('model');
                if (context.signal?.aborted) throw new ConnectorError('aborted', '调用已取消');
                return {
                    data: data as T,
                    mode: 'demo',
                    usage: { inputTokens: 0, outputTokens: 0, estimated: true },
                };
            },
        },
    };
}
