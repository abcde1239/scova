import { Ajv } from 'ajv';
import type { SafeHttpClient } from './http.ts';
import { createTavilySearch, createModelProvider } from './providers.ts';
import { pageFingerprint } from './reader.ts';
import { createPageReader } from './browser-reader.ts';
import { createSearxngSearch } from './searxng.ts';
import { createSearchApi, type SearchApiOptions } from './search-api.ts';
import { createModelSearch, type ModelSearchProtocol } from './model-search.ts';
import { ConnectorError } from './types.ts';
import type { ModelProtocol } from './model-protocol.ts';
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
        managedSearch?: boolean;
        modelApiKey?: string;
        model?: string;
        modelBaseUrl?: string;
        modelProtocol?: ModelProtocol;
        modelSearch?: ModelSearchProtocol | 'disabled';
        http?: SafeHttpClient;
    } = {},
): ConnectorBundle {
    const searchProvider = options.searchProvider ?? 'searxng';
    const modelSearch = options.modelSearch === 'disabled' ? undefined : options.modelSearch;
    if (!['searxng', 'tavily', 'api'].includes(searchProvider))
        throw new ConnectorError('configuration', '搜索服务选项无效');
    if (!modelSearch && searchProvider === 'api' && !options.searchApi)
        throw new ConnectorError('configuration', '搜索 API 未配置');
    if (
        (options.modelSearch === 'anthropic_web_search' &&
            options.modelProtocol !== 'anthropic_messages') ||
        (options.modelSearch === 'openai_responses' &&
            options.modelProtocol &&
            !['openai_chat_completions', 'openai_json'].includes(options.modelProtocol))
    )
        throw new ConnectorError('configuration', '内置搜索与模型协议不匹配');
    const nativeSearch = modelSearch
        ? createModelSearch({
              protocol: modelSearch,
              model: options.model ?? '',
              baseUrl: options.modelBaseUrl ?? 'https://api.openai.com/v1',
              apiKey: options.modelApiKey ?? '',
              http: options.http,
          })
        : undefined;
    const apiSearch =
        !nativeSearch && searchProvider === 'api'
            ? createSearchApi({
                  ...options.searchApi!,
                  http: options.searchApi!.http ?? options.http,
                  maxResults: options.managedSearch ? 10 : options.searchApi!.maxResults,
              })
            : undefined;
    if (
        (nativeSearch ||
            searchProvider === 'searxng' ||
            apiSearch ||
            options.tavilyApiKey?.trim()) &&
        options.modelApiKey?.trim() &&
        options.model?.trim()
    ) {
        return {
            mode: 'live',
            search:
                nativeSearch ??
                apiSearch ??
                (searchProvider === 'searxng'
                    ? createSearxngSearch({
                          baseUrl: options.searxngBaseUrl,
                          http: options.http,
                          maxResults: options.managedSearch ? 10 : undefined,
                          maxAttempts: options.managedSearch ? 1 : undefined,
                      })
                    : createTavilySearch({ apiKey: options.tavilyApiKey!, http: options.http })),
            reader: createPageReader({ http: options.http }),
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
