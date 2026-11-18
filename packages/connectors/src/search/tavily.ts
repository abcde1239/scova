import { normalizeUrl } from '../http/index.ts';
import { prepareProvider, record, parseJson, type ProviderOptions } from '../http/provider.ts';
import { ConnectorError, type SearchProvider } from '../types.ts';
import { searchLanguage } from './language.ts';

export function createTavilySearch(options: ProviderOptions): SearchProvider {
    if (!options.apiKey.trim()) throw new ConnectorError('configuration', '供应商密钥未配置');
    const provider = prepareProvider(options);
    return {
        async search(query, context = {}) {
            const language = searchLanguage(context);
            if (!query.trim() || query.length > 2_000)
                throw new ConnectorError('configuration', '搜索词为空或超长');
            const response = await provider.call('search', context, (signal) =>
                provider.http.request('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${options.apiKey}`,
                    },
                    body: JSON.stringify({
                        query,
                        max_results: 5,
                        search_depth: 'basic',
                        include_answer: false,
                        include_raw_content: false,
                        ...(language ? { language } : {}),
                    }),
                    signal,
                    maxRedirects: 0,
                }),
            );
            const parsed = parseJson(response.body);
            if (!record(parsed) || !Array.isArray(parsed.results) || parsed.results.length > 5)
                throw new ConnectorError('invalid_response', '搜索结果结构无效');
            const results = parsed.results.map((item: unknown) => {
                if (
                    !record(item) ||
                    typeof item.url !== 'string' ||
                    typeof item.title !== 'string' ||
                    typeof item.content !== 'string' ||
                    item.title.length > 2_000 ||
                    item.content.length > 20_000 ||
                    (item.score !== undefined &&
                        (typeof item.score !== 'number' || !Number.isFinite(item.score)))
                ) {
                    throw new ConnectorError('invalid_response', '搜索条目结构无效');
                }
                return {
                    kind: 'search_snippet' as const,
                    originalUrl: item.url,
                    url: normalizeUrl(item.url),
                    title: item.title,
                    snippet: item.content,
                    ...(typeof item.score === 'number' ? { score: item.score } : {}),
                };
            });
            return {
                kind: 'search_results',
                mode: 'live',
                provider: 'tavily',
                query,
                searchedAt: new Date().toISOString(),
                results,
                coverage: {
                    complete: true,
                    gaps: [],
                    unresponsiveEngines: [],
                    receivedResults: results.length,
                    returnedResults: results.length,
                    discardedResults: 0,
                    totalResults: null,
                    truncated: false,
                },
            };
        },
    };
}
