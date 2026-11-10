import { ConnectorError, type SearchApiOptions } from '@scova/connectors';

/** Search credentials belong to deployment configuration and never inherit an account model key. */
export function readSearchConfig(env: NodeJS.ProcessEnv): {
    searchProvider: 'searxng' | 'tavily' | 'api';
    searxngBaseUrl?: string;
    tavilyApiKey?: string;
    searchApi?: SearchApiOptions;
} {
    const provider = env.SEARCH_PROVIDER ?? 'searxng';
    if (provider !== 'searxng' && provider !== 'tavily' && provider !== 'api')
        throw new ConnectorError('configuration', '搜索服务选项无效');
    if (provider !== 'api')
        return {
            searchProvider: provider,
            searxngBaseUrl: env.SEARXNG_BASE_URL,
            tavilyApiKey: env.TAVILY_API_KEY,
        };
    const protocol = env.SEARCH_API_PROTOCOL;
    if (protocol !== 'deepseek' && protocol !== 'perplexity')
        throw new ConnectorError('configuration', 'SEARCH_API_PROTOCOL 配置无效');
    const searchType = env.SEARCH_API_SEARCH_TYPE || undefined;
    if (searchType !== undefined && searchType !== 'web' && searchType !== 'fast')
        throw new ConnectorError('configuration', 'SEARCH_API_SEARCH_TYPE 配置无效');
    return {
        searchProvider: 'api',
        searchApi: {
            protocol,
            apiKey: env.SEARCH_API_KEY ?? '',
            baseUrl: env.SEARCH_API_BASE_URL || undefined,
            searchType,
        },
    };
}
