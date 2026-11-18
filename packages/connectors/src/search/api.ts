import {
    createSafeHttpClient,
    normalizeUrl,
    positiveLimit,
    validatePublicUrl,
} from '../http/index.ts';
import { createHash } from 'node:crypto';
import { createPublicDnsResolver } from '../http/dns.ts';
import { prepareProvider, type ProviderOptions } from '../http/provider.ts';
import {
    ConnectorError,
    PAGE_TEXT_CHAR_LIMIT,
    READ_CALL_TIMEOUT_MS,
    type SearchProvider,
    type SearchResult,
    type PageReader,
    type ReadPage,
} from '../types.ts';

export type SearchApiProtocol = 'deepseek' | 'perplexity' | 'tavily';

export interface SearchApiOptions extends ProviderOptions {
    protocol: SearchApiProtocol;
    /** Deployment-owned API root, including an optional path prefix; never a task URL. */
    baseUrl?: string;
    maxResults?: number;
    searchType?: 'web' | 'fast';
    /** Legacy wire values, both now use provider reading exclusively. */
    contentMode?: 'prefer_api' | 'reader';
}

const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

function searchEndpoint(protocol: SearchApiProtocol, baseUrl?: string, read = false): string {
    try {
        const base = validatePublicUrl(
            baseUrl ??
                (protocol === 'deepseek'
                    ? 'https://api.deepseek.com/v1'
                    : protocol === 'tavily'
                      ? 'https://api.tavily.com'
                      : 'https://api.perplexity.ai'),
        );
        // validatePublicUrl removes fragments, so inspect the original as well.
        if (base.protocol !== 'https:' || base.search || new URL(baseUrl ?? base).hash)
            throw new Error();
        const action = read
            ? protocol === 'deepseek'
                ? 'tools/fetch'
                : 'extract'
            : protocol === 'deepseek'
              ? 'tools/search'
              : 'search';
        base.pathname = `${base.pathname.replace(/\/+$/, '')}/${action}`;
        return base.toString();
    } catch {
        throw new ConnectorError(
            'configuration',
            '搜索 API 地址必须为无凭据和查询参数的公网 HTTPS 地址',
        );
    }
}

/** Generated answers/snippets never become page bodies; provider bodies still pass read validation. */
export function createSearchApi(options: SearchApiOptions): SearchProvider & PageReader {
    if (!['deepseek', 'perplexity', 'tavily'].includes(options.protocol))
        throw new ConnectorError('configuration', '搜索 API 协议不受支持');
    if (!options.apiKey?.trim() || /[\r\n]/.test(options.apiKey) || options.apiKey.length > 8192)
        throw new ConnectorError('configuration', '搜索 API 密钥未配置或无效');
    if (
        options.searchType !== undefined &&
        (options.protocol !== 'perplexity' || !['web', 'fast'].includes(options.searchType))
    )
        throw new ConnectorError('configuration', '搜索 API 搜索类型不受支持');
    const endpoint = searchEndpoint(options.protocol, options.baseUrl);
    const readEndpoint = searchEndpoint(options.protocol, options.baseUrl, true);
    if (
        options.contentMode !== undefined &&
        !['prefer_api', 'reader'].includes(options.contentMode)
    )
        throw new ConnectorError('configuration', '搜索正文选项无效');
    const maxResults = positiveLimit(options.maxResults ?? 5, 10, '搜索结果数量');
    const provider = prepareProvider({
        ...options,
        // Paid requests are not automatically replayed unless explicitly configured by a caller.
        maxAttempts: options.maxAttempts ?? 1,
        readTimeoutMs: READ_CALL_TIMEOUT_MS,
        http:
            options.http ??
            createSafeHttpClient({
                maxTimeoutMs: READ_CALL_TIMEOUT_MS,
                resolve: createPublicDnsResolver({
                    mode: process.env.SEARCH_DNS_RESOLVER ?? 'auto',
                    configName: 'SEARCH_DNS_RESOLVER',
                }),
            }),
    });
    return {
        async read(originalUrl, context = {}) {
            const url = normalizeUrl(originalUrl);
            if (context.signal?.aborted) throw new ConnectorError('aborted', '网页读取已停止');
            if (options.protocol === 'perplexity')
                throw new ConnectorError(
                    'configuration',
                    'Perplexity Search 尚不支持独立网页读取，请选择 DeepSeek 或 Tavily',
                );
            const response = await provider.call('read', context, (signal) =>
                provider.http.request(readEndpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${options.apiKey.trim()}`,
                    },
                    body: JSON.stringify(
                        options.protocol === 'deepseek'
                            ? { url }
                            : { urls: [url], extract_depth: 'advanced', format: 'markdown' },
                    ),
                    signal,
                    timeoutMs: Math.min(
                        context.timeoutMs ?? READ_CALL_TIMEOUT_MS,
                        READ_CALL_TIMEOUT_MS,
                    ),
                    beforeDispatch: context.beforeDispatch,
                    onReadDiagnostic: context.onReadDiagnostic,
                    maxRedirects: 0,
                }),
            );
            let parsed: unknown;
            try {
                parsed = JSON.parse(response.body);
            } catch {
                throw new ConnectorError('invalid_response', '网页读取 API 响应不是有效 JSON');
            }
            if (!record(parsed))
                throw new ConnectorError('invalid_response', '网页读取 API 结果结构无效');
            let body: unknown;
            let title: unknown;
            if (options.protocol === 'deepseek') {
                body = parsed.content;
                title = parsed.title;
            } else {
                if (
                    !Array.isArray(parsed.results) ||
                    parsed.results.length > 20 ||
                    !Array.isArray(parsed.failed_results) ||
                    parsed.failed_results.length > 20
                )
                    throw new ConnectorError('invalid_response', '网页读取 API 结果结构无效');
                const matches = (item: unknown) => {
                    if (!record(item) || typeof item.url !== 'string') return false;
                    try {
                        return normalizeUrl(item.url) === url;
                    } catch {
                        return false;
                    }
                };
                if (parsed.failed_results.some(matches))
                    throw new ConnectorError('extraction_failed', '网页读取 API 未能提取指定页面');
                const item = parsed.results.find(matches);
                if (!record(item))
                    throw new ConnectorError('invalid_response', '网页读取 API 未返回指定页面');
                body = item.raw_content;
                title = item.title;
            }
            if (typeof body !== 'string' || !body.trim())
                throw new ConnectorError('extraction_failed', '网页读取 API 未返回正文');
            const text = body.slice(0, PAGE_TEXT_CHAR_LIMIT).replace(/[\uD800-\uDBFF]$/, '');
            return {
                kind: 'read_page',
                mode: 'live',
                originalUrl,
                fetchedUrl: url,
                url,
                title: typeof title === 'string' ? title.slice(0, 2000) : url,
                text,
                contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
                extractionVersion: `search-api/${options.protocol}/fetch-v1`,
                collectedAt: new Date().toISOString(),
                truncated: text.length < body.length,
                untrusted: true,
            } satisfies ReadPage;
        },
        async search(query, context = {}) {
            const queryLength = Array.from(query).length;
            if (!query.trim() || queryLength > (options.protocol === 'deepseek' ? 128 : 2000))
                throw new ConnectorError('configuration', '搜索词为空或超过搜索 API 长度限制');
            const response = await provider.call('search', context, (signal) =>
                provider.http.request(endpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${options.apiKey.trim()}`,
                    },
                    body: JSON.stringify(
                        options.protocol === 'deepseek'
                            ? {
                                  query,
                                  count: maxResults,
                                  need_content: true,
                              }
                            : options.protocol === 'tavily'
                              ? {
                                    query,
                                    max_results: maxResults,
                                    include_raw_content: true,
                                    include_answer: false,
                                }
                              : {
                                    query,
                                    max_results: maxResults,
                                    search_type: options.searchType ?? 'web',
                                },
                    ),
                    signal,
                    maxRedirects: 0,
                }),
            );
            let parsed: unknown;
            try {
                parsed = JSON.parse(response.body);
            } catch {
                throw new ConnectorError('invalid_response', '搜索 API 响应不是有效 JSON');
            }
            if (!record(parsed) || !Array.isArray(parsed.results) || parsed.results.length > 50)
                throw new ConnectorError('invalid_response', '搜索 API 结果结构无效');
            const results: SearchResult[] = [];
            const seen = new Set<string>();
            let discarded = 0;
            let bodyBytes = 800_000;
            const searchedAt = new Date().toISOString();
            for (const item of parsed.results) {
                const snippet = record(item)
                    ? options.protocol === 'tavily'
                        ? item.content
                        : item.snippet
                    : undefined;
                if (
                    !record(item) ||
                    typeof item.url !== 'string' ||
                    item.url.length > 8192 ||
                    typeof item.title !== 'string' ||
                    item.title.length > 2000 ||
                    typeof snippet !== 'string' ||
                    snippet.length > 20_000
                ) {
                    discarded++;
                    continue;
                }
                let url: string;
                try {
                    url = normalizeUrl(item.url);
                } catch {
                    discarded++;
                    continue;
                }
                if (seen.has(url)) {
                    discarded++;
                    continue;
                }
                seen.add(url);
                const result: SearchResult = {
                    kind: 'search_snippet',
                    originalUrl: item.url,
                    url,
                    title: item.title,
                    snippet,
                };
                const body =
                    options.protocol === 'deepseek'
                        ? item.content
                        : options.protocol === 'tavily'
                          ? item.raw_content
                          : undefined;
                if (
                    results.length < maxResults &&
                    typeof body === 'string' &&
                    body.trim() &&
                    bodyBytes > 0
                ) {
                    const chars: string[] = [];
                    for (const char of body) {
                        const size = Buffer.byteLength(char, 'utf8');
                        if (chars.length >= 100_000 || size > bodyBytes) break;
                        chars.push(char);
                        bodyBytes -= size;
                    }
                    const text = chars.join('');
                    if (text.trim())
                        result.page = {
                            kind: 'read_page',
                            mode: 'live',
                            originalUrl: item.url,
                            fetchedUrl: url,
                            url,
                            title: item.title,
                            text,
                            contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
                            extractionVersion: `search-api/${options.protocol}/v1`,
                            collectedAt: searchedAt,
                            // Completeness of provider extraction is unknown independently of local clipping.
                            truncated: text.length < body.length,
                            untrusted: true,
                        };
                }
                results.push(result);
            }
            const truncated = results.length > maxResults;
            const gaps: string[] = [];
            if (discarded) gaps.push('部分搜索条目无效、地址不安全或重复，已过滤');
            if (truncated) gaps.push('搜索结果已按调用上限截断');
            return {
                kind: 'search_results',
                mode: 'live',
                provider: options.protocol,
                query,
                searchedAt,
                results: results.slice(0, maxResults),
                coverage: {
                    complete: !gaps.length,
                    gaps,
                    unresponsiveEngines: [],
                    receivedResults: parsed.results.length,
                    returnedResults: Math.min(results.length, maxResults),
                    discardedResults: discarded,
                    totalResults: null,
                    truncated,
                },
            };
        },
    };
}
