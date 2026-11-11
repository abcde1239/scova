import { ConnectorError, type SearchApiOptions } from '@scova/connectors';
import type { ProviderCredentials } from '@scova/shared/credentials';

export function effectiveSearchConfig(
    env: NodeJS.ProcessEnv,
    account: { webSearch?: string; searchApi?: ProviderCredentials['searchApi'] },
) {
    if (account.webSearch && account.webSearch !== 'disabled') {
        if (account.searchApi) throw new ConnectorError('configuration', '账号搜索配置冲突');
        return {};
    }
    if (account.searchApi) return { searchProvider: 'api' as const, searchApi: account.searchApi };
    return readSearchConfig(env);
}

/** Deployment fallback; search credentials never inherit a model key. */
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
    if (protocol !== 'deepseek' && protocol !== 'perplexity' && protocol !== 'tavily')
        throw new ConnectorError('configuration', 'SEARCH_API_PROTOCOL 配置无效');
    const searchType = env.SEARCH_API_SEARCH_TYPE || undefined;
    if (searchType !== undefined && searchType !== 'web' && searchType !== 'fast')
        throw new ConnectorError('configuration', 'SEARCH_API_SEARCH_TYPE 配置无效');
    const contentMode = env.SEARCH_API_CONTENT_MODE ?? 'reader';
    if (contentMode !== 'reader' && contentMode !== 'prefer_api')
        throw new ConnectorError('configuration', 'SEARCH_API_CONTENT_MODE 配置无效');
    return {
        searchProvider: 'api',
        searchApi: {
            protocol,
            apiKey: env.SEARCH_API_KEY ?? '',
            baseUrl: env.SEARCH_API_BASE_URL || undefined,
            searchType,
            contentMode,
        },
    };
}
