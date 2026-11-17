import { ConnectorError, type SearchApiOptions } from '@scova/connectors';
import type { SearchMode } from '@scova/models';
import type { searchConfigurations } from '@scova/db';
import { openCredential } from '@scova/shared/credentials';

export interface AccountSearchConfig {
    defaultMode: 'api' | 'searxng';
    searchApi?: SearchApiOptions;
}

export class SearchConfigurationError extends ConnectorError {
    constructor(
        readonly failureCode:
            | 'SEARCH_API_NOT_CONFIGURED'
            | 'SEARCH_CREDENTIAL_INVALID'
            | 'SEARCH_API_READING_UNSUPPORTED',
    ) {
        super(
            'configuration',
            failureCode === 'SEARCH_API_NOT_CONFIGURED'
                ? '请在账号中配置 Search API，或选择内置 SearXNG'
                : failureCode === 'SEARCH_API_READING_UNSUPPORTED'
                  ? 'Perplexity Search 暂不支持独立网页读取，请在账号中改选 DeepSeek 或 Tavily'
                  : '搜索密钥无法读取，请在账号中重新保存 Search API',
        );
    }
}

function searchCredential(value: string, userId: string, id: string, key?: string) {
    try {
        return openCredential(value, userId, id, key);
    } catch {
        throw new SearchConfigurationError('SEARCH_CREDENTIAL_INVALID');
    }
}

type SearchRecord = Pick<
    typeof searchConfigurations.$inferSelect,
    'id' | 'defaultMode' | 'protocol' | 'baseUrl' | 'contentMode' | 'encryptedApiKey'
>;

export function accountSearchConfig(
    env: NodeJS.ProcessEnv,
    account: SearchRecord | null,
    userId: string,
    mode: SearchMode = 'auto',
) {
    const selected = mode === 'auto' ? (account?.defaultMode ?? 'searxng') : mode;
    const searchApi =
        selected === 'api' &&
        account?.encryptedApiKey &&
        account.protocol &&
        account.baseUrl &&
        account.contentMode
            ? {
                  protocol: account.protocol,
                  baseUrl: account.baseUrl,
                  contentMode: 'prefer_api' as const,
                  apiKey: searchCredential(
                      account.encryptedApiKey,
                      userId,
                      account.id,
                      env.AGENT_CREDENTIAL_KEY,
                  ),
              }
            : undefined;
    return effectiveSearchConfig(
        env,
        account ? { defaultMode: account.defaultMode, searchApi } : null,
        mode,
    );
}

export function effectiveSearchConfig(
    env: NodeJS.ProcessEnv,
    account: AccountSearchConfig | null,
    mode: SearchMode = 'auto',
) {
    const selected = mode === 'auto' ? (account?.defaultMode ?? 'searxng') : mode;
    if (selected === 'searxng')
        return {
            searchProvider: 'searxng' as const,
            searxngBaseUrl: env.SEARXNG_BASE_URL,
            modelSearch: 'disabled' as const,
        };
    if (selected !== 'api' || !account?.searchApi?.apiKey.trim())
        throw new SearchConfigurationError('SEARCH_API_NOT_CONFIGURED');
    if (account.searchApi.protocol === 'perplexity')
        throw new SearchConfigurationError('SEARCH_API_READING_UNSUPPORTED');
    return {
        searchProvider: 'api' as const,
        searchApi: account.searchApi,
        modelSearch: 'disabled' as const,
    };
}
