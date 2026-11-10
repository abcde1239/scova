import { normalizeUrl, validatePublicUrl } from './http.ts';
import { createModelHttpClient } from './model-http.ts';
import { prepareProvider, type ProviderOptions } from './providers.ts';
import {
    ConnectorError,
    MODEL_CALL_TIMEOUT_MS,
    type SearchProvider,
    type SearchResult,
} from './types.ts';

export type ModelSearchProtocol = 'openai_responses' | 'anthropic_web_search';
export interface ModelSearchOptions extends Omit<ProviderOptions, 'maxAttempts' | 'retryDelayMs'> {
    protocol: ModelSearchProtocol;
    model: string;
    baseUrl: string;
}
const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = () => new ConnectorError('invalid_response', '内置搜索未返回完整的搜索来源或用量');
const tokens = (v: unknown): number => {
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid();
    return v as number;
};
export const MODEL_SEARCH_RESERVATION = Object.freeze({ inputTokens: 16_384, outputTokens: 1024 });

/** Model answers and encrypted search content are deliberately excluded from candidate evidence. */
export function createModelSearch(options: ModelSearchOptions): SearchProvider {
    if (
        !['openai_responses', 'anthropic_web_search'].includes(options.protocol) ||
        !options.model?.trim() ||
        !options.apiKey?.trim() ||
        /[\r\n]/.test(options.apiKey)
    )
        throw new ConnectorError('configuration', '内置搜索配置无效');
    const endpoint = validatePublicUrl(options.baseUrl);
    if (endpoint.protocol !== 'https:' || endpoint.search || new URL(options.baseUrl).hash)
        throw new ConnectorError('configuration', '内置搜索需要公网 HTTPS API 根地址');
    const openai = options.protocol === 'openai_responses';
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${openai ? 'responses' : 'messages'}`;
    const provider = prepareProvider({
        ...options,
        maxAttempts: 1,
        http: options.http ?? createModelHttpClient(),
    });
    return {
        tokenReservation: MODEL_SEARCH_RESERVATION,
        async search(query, context = {}) {
            if (!query.trim() || Array.from(query).length > 2000)
                throw new ConnectorError('configuration', '内置搜索词为空或过长');
            const prompt = `Search the web for this query. Use web search once. Return source links, without a synthesized answer. Query: ${query}`;
            const response = await provider.call(
                'model',
                {
                    ...context,
                    beforeAttempt: (_kind, error) => context.beforeAttempt?.('search', error),
                },
                (signal) =>
                    provider.http.request(endpoint.toString(), {
                        method: 'POST',
                        maxRedirects: 0,
                        timeoutMs: Math.min(
                            context.timeoutMs ?? MODEL_CALL_TIMEOUT_MS,
                            MODEL_CALL_TIMEOUT_MS,
                        ),
                        signal,
                        headers: openai
                            ? {
                                  'content-type': 'application/json',
                                  authorization: `Bearer ${options.apiKey.trim()}`,
                              }
                            : {
                                  'content-type': 'application/json',
                                  'x-api-key': options.apiKey.trim(),
                                  'anthropic-version': '2023-06-01',
                              },
                        body: JSON.stringify(
                            openai
                                ? {
                                      model: options.model,
                                      input: prompt,
                                      store: false,
                                      max_output_tokens: MODEL_SEARCH_RESERVATION.outputTokens,
                                      max_tool_calls: 1,
                                      tools: [{ type: 'web_search', search_context_size: 'low' }],
                                      tool_choice: { type: 'web_search' },
                                      include: ['web_search_call.action.sources'],
                                  }
                                : {
                                      model: options.model,
                                      max_tokens: MODEL_SEARCH_RESERVATION.outputTokens,
                                      messages: [{ role: 'user', content: prompt }],
                                      tools: [
                                          {
                                              type: 'web_search_20250305',
                                              name: 'web_search',
                                              max_uses: 1,
                                          },
                                      ],
                                      tool_choice: { type: 'tool', name: 'web_search' },
                                  },
                        ),
                    }),
            );
            let body: unknown;
            try {
                body = JSON.parse(response.body);
            } catch {
                throw invalid();
            }
            if (!record(body) || !record(body.usage)) throw invalid();
            let raw: unknown[];
            let inputTokens: number;
            let outputTokens: number;
            if (openai) {
                if (body.status !== 'completed' || !Array.isArray(body.output)) throw invalid();
                const calls = body.output.filter((v) => record(v) && v.type === 'web_search_call');
                if (calls.length !== 1) throw invalid();
                const call = calls[0];
                if (
                    !record(call) ||
                    call.status !== 'completed' ||
                    !record(call.action) ||
                    call.action.type !== 'search' ||
                    !Array.isArray(call.action.sources)
                )
                    throw invalid();
                raw = call.action.sources;
                inputTokens = tokens(body.usage.input_tokens);
                outputTokens = tokens(body.usage.output_tokens);
            } else {
                if (
                    body.stop_reason !== 'end_turn' ||
                    !Array.isArray(body.content) ||
                    !record(body.usage.server_tool_use) ||
                    body.usage.server_tool_use.web_search_requests !== 1
                )
                    throw invalid();
                const calls = body.content.filter((v) => record(v) && v.type === 'server_tool_use');
                const results = body.content.filter(
                    (v) => record(v) && v.type === 'web_search_tool_result',
                );
                if (
                    calls.length !== 1 ||
                    !record(calls[0]) ||
                    calls[0].name !== 'web_search' ||
                    results.length !== 1 ||
                    !record(results[0]) ||
                    results[0].tool_use_id !== calls[0].id ||
                    !Array.isArray(results[0].content)
                )
                    throw invalid();
                raw = results[0].content;
                inputTokens =
                    tokens(body.usage.input_tokens) +
                    tokens(body.usage.cache_creation_input_tokens ?? 0) +
                    tokens(body.usage.cache_read_input_tokens ?? 0);
                outputTokens = tokens(body.usage.output_tokens);
            }
            if (
                inputTokens > MODEL_SEARCH_RESERVATION.inputTokens ||
                outputTokens > MODEL_SEARCH_RESERVATION.outputTokens
            )
                throw new ConnectorError(
                    'budget_exceeded',
                    '内置搜索模型用量超出预留，停止后续调用',
                );
            if (raw.length > 100) throw invalid();
            const results: SearchResult[] = [];
            const seen = new Set<string>();
            let discarded = 0;
            for (const item of raw) {
                try {
                    if (
                        !record(item) ||
                        typeof item.url !== 'string' ||
                        item.url.length > 8192 ||
                        (item.title !== undefined &&
                            (typeof item.title !== 'string' || item.title.length > 2000))
                    )
                        throw invalid();
                    const url = normalizeUrl(item.url);
                    if (seen.has(url)) throw invalid();
                    seen.add(url);
                    results.push({
                        kind: 'search_snippet',
                        originalUrl: item.url,
                        url,
                        title: typeof item.title === 'string' ? item.title : url,
                        snippet: '',
                    });
                } catch {
                    discarded++;
                }
            }
            const truncated = results.length > 10;
            return {
                kind: 'search_results',
                mode: 'live',
                provider: options.protocol,
                query,
                searchedAt: new Date().toISOString(),
                results: results.slice(0, 10),
                usage: { inputTokens, outputTokens, estimated: false },
                coverage: {
                    complete: !discarded && !truncated,
                    gaps:
                        discarded || truncated ? ['部分内置搜索来源无效、重复或超过候选上限'] : [],
                    unresponsiveEngines: [],
                    receivedResults: raw.length,
                    returnedResults: Math.min(results.length, 10),
                    discardedResults: discarded,
                    totalResults: null,
                    truncated,
                },
            };
        },
    };
}
