import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { JSDOM } from 'jsdom';
import {
    isPublicIp,
    nodeHttpTransport,
    normalizeUrl,
    positiveLimit,
    withDeadline,
} from './http.ts';
import type { HttpTransport, ResolvedAddress, SafeHttpClient } from './http.ts';
import { prepareProvider } from './providers.ts';
import { ConnectorError } from './types.ts';
import type { SearchProvider, SearchResult } from './types.ts';

export const DEFAULT_SEARXNG_BASE_URL = 'http://127.0.0.1:8080';

function serviceEndpoint(baseUrl: string): URL {
    let base: URL;
    try {
        base = new URL(baseUrl);
    } catch {
        throw new ConnectorError('configuration', 'SearxNG 服务地址无效');
    }
    if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== '/'
    ) {
        throw new ConnectorError('configuration', 'SearxNG 地址必须为固定 HTTP(S) origin');
    }
    return new URL('/search', base);
}

function isServiceAddress(address: string): boolean {
    if (isPublicIp(address)) return true;
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return (
            a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        );
    }
    return isIP(address) === 6 && (address === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(address));
}

/** Private-network access belongs only to this deployer-fixed search endpoint, never PageReader. */
export function createSearxngServiceClient(
    baseUrl = DEFAULT_SEARXNG_BASE_URL,
    config: {
        resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
        transport?: HttpTransport;
    } = {},
): SafeHttpClient {
    const endpoint = serviceEndpoint(baseUrl);
    const resolve =
        config.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
    const transport = config.transport ?? nodeHttpTransport;
    return {
        async request(url, options = {}) {
            if (
                url !== endpoint.toString() ||
                options.method !== 'POST' ||
                (options.maxRedirects !== undefined && options.maxRedirects !== 0) ||
                typeof options.body !== 'string' ||
                Buffer.byteLength(options.body) > 32_000
            ) {
                throw new ConnectorError('unsafe_url', '内部搜索客户端只允许固定搜索请求');
            }
            const form = new URLSearchParams(options.body);
            if (
                form.get('format') !== 'json' ||
                !form.get('q')?.trim() ||
                [...form.keys()].some((key) => key !== 'q' && key !== 'format') ||
                form.getAll('q').length !== 1 ||
                form.getAll('format').length !== 1
            ) {
                throw new ConnectorError('unsafe_url', '内部搜索参数无效');
            }
            const maxBytes = positiveLimit(
                options.maxBytes ?? 2 * 1024 * 1024,
                2 * 1024 * 1024,
                '响应大小',
            );
            return withDeadline(
                Math.min(options.timeoutMs ?? 15_000, 15_000),
                options.signal,
                async (signal) => {
                    const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
                    let addresses: ResolvedAddress[];
                    try {
                        addresses = isIP(hostname)
                            ? [{ address: hostname, family: isIP(hostname) }]
                            : await resolve(hostname);
                    } catch {
                        throw new ConnectorError('network', '内部搜索域名解析失败', true);
                    }
                    if (
                        !addresses.length ||
                        addresses.some(
                            (entry) =>
                                isIP(entry.address) !== entry.family ||
                                !isServiceAddress(entry.address),
                        )
                    ) {
                        throw new ConnectorError('unsafe_url', '内部搜索服务地址不允许');
                    }
                    if (signal.aborted) throw signal.reason;
                    let response;
                    try {
                        response = await transport(new URL(endpoint), {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/x-www-form-urlencoded',
                                accept: 'application/json',
                            },
                            body: options.body,
                            signal,
                            maxBytes,
                            address: addresses[0],
                        });
                    } catch (error) {
                        if (error instanceof ConnectorError) throw error;
                        throw new ConnectorError('network', '内部搜索连接失败', true);
                    }
                    if (Buffer.byteLength(response.body) > maxBytes)
                        throw new ConnectorError('response_too_large', '搜索响应超过下载限制');
                    if (response.status >= 300 && response.status < 400)
                        throw new ConnectorError('unsafe_url', '内部搜索服务禁止重定向');
                    return { ...response, url: endpoint.toString() };
                },
            );
        },
    };
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plainText(value: string): string {
    const dom = new JSDOM(`<body>${value}</body>`);
    try {
        dom.window.document
            .querySelectorAll('script,style,iframe,object,embed')
            .forEach((node) => node.remove());
        return dom.window.document.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    } finally {
        dom.window.close();
    }
}

export function createSearxngSearch(
    options: {
        baseUrl?: string;
        http?: SafeHttpClient;
        maxResults?: number;
        maxAttempts?: number;
        retryDelayMs?: number;
    } = {},
): SearchProvider {
    const baseUrl = options.baseUrl ?? DEFAULT_SEARXNG_BASE_URL;
    const endpoint = serviceEndpoint(baseUrl).toString();
    const maxResults = positiveLimit(options.maxResults ?? 5, 10, '搜索结果上限');
    const provider = prepareProvider({
        ...options,
        http: options.http ?? createSearxngServiceClient(baseUrl),
    });
    return {
        async search(query, context = {}) {
            if (!query.trim() || query.length > 2_000)
                throw new ConnectorError('configuration', '搜索词为空或超长');
            const response = await provider
                .call('search', context, (signal) =>
                    provider.http.request(endpoint, {
                        method: 'POST',
                        body: new URLSearchParams({ q: query, format: 'json' }).toString(),
                        headers: {
                            'content-type': 'application/x-www-form-urlencoded',
                            accept: 'application/json',
                        },
                        signal,
                        maxRedirects: 0,
                        maxBytes: 2 * 1024 * 1024,
                    }),
                )
                .catch((error: unknown) => {
                    if (error instanceof ConnectorError && error.status === 403) {
                        throw new ConnectorError(
                            'http',
                            'SearxNG 拒绝请求，请检查 JSON 格式启用及访问控制配置',
                            false,
                            403,
                        );
                    }
                    throw error;
                });
            let parsed: unknown;
            try {
                parsed = JSON.parse(response.body);
            } catch {
                throw new ConnectorError(
                    'invalid_response',
                    'SearxNG 未返回 JSON，请检查 JSON 格式配置',
                );
            }
            if (
                !record(parsed) ||
                !Array.isArray(parsed.results) ||
                parsed.results.length > 1_000 ||
                (parsed.unresponsive_engines !== undefined &&
                    !Array.isArray(parsed.unresponsive_engines))
            ) {
                throw new ConnectorError('invalid_response', 'SearxNG 响应结构无效');
            }
            if (
                parsed.number_of_results !== undefined &&
                (!Number.isSafeInteger(parsed.number_of_results) ||
                    (parsed.number_of_results as number) < 0)
            ) {
                throw new ConnectorError('invalid_response', 'SearxNG 结果数量无效');
            }
            const failures = (parsed.unresponsive_engines ?? []) as unknown[];
            if (failures.length > 100)
                throw new ConnectorError('invalid_response', '搜索引擎错误信息超限');
            const unresponsiveEngines = failures.map((item) => {
                if (
                    !Array.isArray(item) ||
                    item.length !== 2 ||
                    typeof item[0] !== 'string' ||
                    typeof item[1] !== 'string' ||
                    !/^[\w .()-]{1,100}$/.test(item[0])
                )
                    throw new ConnectorError('invalid_response', '搜索引擎错误结构无效');
                const reason = /timeout/i.test(item[1])
                    ? 'timeout'
                    : /429|rate|limit/i.test(item[1])
                      ? 'rate_limited'
                      : /captcha/i.test(item[1])
                        ? 'captcha'
                        : 'unavailable';
                return { engine: item[0], error: reason };
            });
            const gaps = unresponsiveEngines.map(
                (failure) => `搜索引擎 ${failure.engine} 未响应（${failure.error}）`,
            );
            const results: SearchResult[] = [];
            let discardedResults = 0;
            for (const [index, item] of parsed.results.entries()) {
                if (
                    !record(item) ||
                    typeof item.url !== 'string' ||
                    typeof item.title !== 'string' ||
                    (item.content !== undefined && typeof item.content !== 'string') ||
                    item.title.length > 2_000 ||
                    (typeof item.content === 'string' && item.content.length > 20_000)
                ) {
                    discardedResults++;
                    gaps.push(`第 ${index + 1} 条搜索条目结构无效，已排除`);
                    continue;
                }
                let url: string;
                try {
                    url = normalizeUrl(item.url);
                } catch {
                    discardedResults++;
                    gaps.push(`第 ${index + 1} 条来源 URL 不安全或无效，已排除`);
                    continue;
                }
                if (results.length >= maxResults) continue;
                const engines = Array.isArray(item.engines)
                    ? item.engines
                          .filter(
                              (value): value is string =>
                                  typeof value === 'string' && /^[\w .()-]{1,100}$/.test(value),
                          )
                          .slice(0, 20)
                    : typeof item.engine === 'string' && /^[\w .()-]{1,100}$/.test(item.engine)
                      ? [item.engine]
                      : [];
                results.push({
                    kind: 'search_snippet',
                    originalUrl: item.url,
                    url,
                    title: plainText(item.title),
                    snippet: plainText(typeof item.content === 'string' ? item.content : ''),
                    ...(engines.length ? { engines } : {}),
                });
            }
            const truncated = parsed.results.length - discardedResults > results.length;
            if (truncated) gaps.push('搜索结果已按调用上限截断');
            if (!results.length && gaps.length)
                throw new ConnectorError(
                    unresponsiveEngines.length ? 'search_unavailable' : 'invalid_response',
                    '搜索没有可用来源，存在引擎失败或无效条目',
                );
            const totalResults =
                Number.isSafeInteger(parsed.number_of_results) &&
                (parsed.number_of_results as number) >= 0
                    ? (parsed.number_of_results as number)
                    : null;
            return {
                kind: 'search_results',
                mode: 'live',
                provider: 'searxng',
                query,
                searchedAt: new Date().toISOString(),
                results,
                coverage: {
                    complete: gaps.length === 0,
                    gaps,
                    unresponsiveEngines,
                    receivedResults: parsed.results.length,
                    returnedResults: results.length,
                    discardedResults,
                    totalResults,
                    truncated,
                },
            };
        },
    };
}
