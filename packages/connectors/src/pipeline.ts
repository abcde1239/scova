import { Ajv } from 'ajv';
import type { SafeHttpClient } from './http.ts';
import { createTavilySearch, createModelProvider } from './providers.ts';
import { createPageReader, pageFingerprint } from './reader.ts';
import { createSearxngSearch } from './searxng.ts';
import { ConnectorError } from './types.ts';
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
        searchProvider?: 'searxng' | 'tavily';
        searxngBaseUrl?: string;
        modelApiKey?: string;
        model?: string;
        modelBaseUrl?: string;
        http?: SafeHttpClient;
    } = {},
): ConnectorBundle {
    const searchProvider = options.searchProvider ?? 'searxng';
    if (searchProvider !== 'searxng' && searchProvider !== 'tavily')
        throw new ConnectorError('configuration', '搜索服务选项无效');
    if (
        (searchProvider === 'searxng' || options.tavilyApiKey?.trim()) &&
        options.modelApiKey?.trim() &&
        options.model?.trim()
    ) {
        return {
            mode: 'live',
            search:
                searchProvider === 'searxng'
                    ? createSearxngSearch({ baseUrl: options.searxngBaseUrl, http: options.http })
                    : createTavilySearch({ apiKey: options.tavilyApiKey!, http: options.http }),
            reader: createPageReader({ http: options.http }),
            model: createModelProvider({
                apiKey: options.modelApiKey,
                model: options.model,
                baseUrl: options.modelBaseUrl,
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
