import {
    createSafeHttpClient,
    normalizeUrl,
    positiveLimit,
    validatePublicUrl,
} from '../http/index.ts';
import { createPublicDnsResolver } from '../http/dns.ts';
import { prepareProvider, record, parseJson, type ProviderOptions } from '../http/provider.ts';
import { ConnectorError, type SearchProvider, type SearchResult } from '../types.ts';
import { searchLanguage, isSearchLanguage } from './language.ts';

export interface CustomJsonSearchTemplate {
    method: 'GET' | 'POST';
    languageMap?: Record<string, string>;
    auth: { type: 'bearer' | 'header'; headerName?: string };
    request: Record<string, string | number | boolean>;
    response: { resultsPath: string; urlPath: string; titlePath: string; snippetPath: string };
}
const forbiddenPaths = new Set(['__proto__', 'constructor', 'prototype']);
const invalid = () =>
    new ConnectorError('configuration', '自定义搜索模板无效，请检查请求字段、认证头及结果路径');

function pathParts(path: string): string[] {
    if (
        typeof path !== 'string' ||
        path.length > 200 ||
        !/^[A-Za-z_][\w-]*(?:(?:\.[A-Za-z_][\w-]*)|(?:\[\d{1,3}\]))*$/.test(path)
    )
        throw invalid();
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    if (parts.length > 12 || parts.some((part) => forbiddenPaths.has(part))) throw invalid();
    return parts;
}
function pick(value: unknown, path: string): unknown {
    let current = value;
    for (const part of pathParts(path)) {
        if ((!record(current) && !Array.isArray(current)) || !Object.hasOwn(current, part))
            return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}
const knownKeys = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));

/** Static validation is also used by account configuration save, without network access. */
export function validateCustomSearchTemplate(value: unknown): CustomJsonSearchTemplate {
    if (
        !record(value) ||
        !knownKeys(value, ['method', 'auth', 'request', 'response', 'languageMap']) ||
        !['GET', 'POST'].includes(String(value.method)) ||
        !record(value.auth) ||
        !record(value.request) ||
        !record(value.response)
    )
        throw invalid();
    if (
        value.languageMap !== undefined &&
        (!record(value.languageMap) ||
            Object.keys(value.languageMap).length > 11 ||
            Object.entries(value.languageMap).some(
                ([key, item]) =>
                    !isSearchLanguage(key) ||
                    typeof item !== 'string' ||
                    !/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(item),
            ))
    )
        throw invalid();
    if (
        !knownKeys(value.auth, ['type', 'headerName']) ||
        !['bearer', 'header'].includes(String(value.auth.type))
    )
        throw invalid();
    if (value.auth.type === 'header') {
        const name = value.auth.headerName;
        if (
            typeof name !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) ||
            /^(?:authorization|host|connection|content-.+|cookie|set-cookie|accept|accept-encoding|origin|referer|user-agent|transfer-encoding|upgrade|expect|trailer|te|proxy-.+|sec-.+|x-forwarded-.+)$/i.test(
                name,
            )
        )
            throw invalid();
    } else if (value.auth.headerName !== undefined) throw invalid();
    const fields = Object.entries(value.request);
    if (!fields.length || fields.length > 24) throw invalid();
    let hasQuery = false;
    for (const [key, item] of fields) {
        if (
            !/^[A-Za-z_][\w-]{0,63}$/.test(key) ||
            forbiddenPaths.has(key) ||
            /(^|[_-])(key|token|secret|password|authorization)($|[_-])/i.test(key)
        )
            throw invalid();
        if (typeof item === 'string') {
            if (
                item.length > 2000 ||
                Array.from(item).some((character) => {
                    const code = character.charCodeAt(0);
                    return code < 32 || code === 127;
                })
            )
                throw invalid();
            const rest = item.replace(/\{\{(query|count|language)\}\}/g, (_, name: string) => {
                // Optional language fields are omitted when no language was selected.
                // At least one query field must survive that omission.
                if (name === 'query' && !item.includes('{{language}}')) hasQuery = true;
                return '';
            });
            if (/[{}]/.test(rest)) throw invalid();
        } else if (
            typeof item !== 'boolean' &&
            !(typeof item === 'number' && Number.isFinite(item))
        )
            throw invalid();
    }
    if (
        !hasQuery ||
        !knownKeys(value.response, ['resultsPath', 'urlPath', 'titlePath', 'snippetPath'])
    )
        throw invalid();
    for (const key of ['resultsPath', 'urlPath', 'titlePath', 'snippetPath'])
        pathParts(value.response[key] as string);
    // Snapshot the configuration: caller mutations cannot reroute an active Run.
    const template = value as unknown as CustomJsonSearchTemplate;
    return {
        method: template.method,
        ...(template.languageMap
            ? {
                  languageMap: Object.fromEntries(
                      Object.entries(template.languageMap).sort(([a], [b]) => a.localeCompare(b)),
                  ),
              }
            : {}),
        auth:
            template.auth.type === 'bearer'
                ? { type: 'bearer' }
                : { type: 'header', headerName: template.auth.headerName },
        request: Object.fromEntries(
            Object.entries(template.request).sort(([a], [b]) => a.localeCompare(b)),
        ),
        response: {
            resultsPath: template.response.resultsPath,
            urlPath: template.response.urlPath,
            titlePath: template.response.titlePath,
            snippetPath: template.response.snippetPath,
        },
    };
}

export function customSearchEndpoint(value: string): string {
    try {
        const url = validatePublicUrl(value);
        if (url.protocol !== 'https:' || url.search || new URL(value).hash) throw new Error();
        // This is a complete endpoint, so /search and /search/ may be distinct routes.
        return url.toString();
    } catch {
        throw new ConnectorError(
            'configuration',
            '自定义搜索地址须为无凭据和查询参数的公网 HTTPS 地址',
        );
    }
}

/** Search-only JSON adapter. Only the explicitly selected local Reader may create page evidence. */
export function createCustomJsonSearch(
    options: ProviderOptions & {
        baseUrl: string;
        custom: CustomJsonSearchTemplate;
        maxResults?: number;
    },
): SearchProvider {
    const endpoint = customSearchEndpoint(options.baseUrl);
    const template = validateCustomSearchTemplate(options.custom);
    const apiKey = options.apiKey?.trim();
    if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey))
        throw new ConnectorError('configuration', '请填写独立搜索密钥');
    const maxResults = positiveLimit(options.maxResults ?? 5, 10, '搜索结果数量');
    const provider = prepareProvider({
        ...options,
        maxAttempts: 1,
        http:
            options.http ??
            createSafeHttpClient({
                resolve: createPublicDnsResolver({
                    mode: process.env.SEARCH_DNS_RESOLVER ?? 'auto',
                    configName: 'SEARCH_DNS_RESOLVER',
                }),
            }),
    });
    return {
        async search(query, context = {}) {
            if (!query.trim() || Array.from(query).length > 2000)
                throw new ConnectorError('configuration', '搜索词为空或过长');
            const requestedLanguage = searchLanguage(context);
            const language = requestedLanguage
                ? (template.languageMap?.[requestedLanguage] ?? requestedLanguage)
                : undefined;
            const values: Record<string, string | number | boolean> = {};
            for (const [key, item] of Object.entries(template.request)) {
                if (typeof item !== 'string') values[key] = item;
                else if (item.includes('{{language}}') && !language) continue;
                else if (item === '{{count}}') values[key] = maxResults;
                else
                    values[key] = item.replace(
                        /\{\{(query|count|language)\}\}/g,
                        (_, name: string) =>
                            name === 'query'
                                ? query
                                : name === 'count'
                                  ? String(maxResults)
                                  : language!,
                    );
            }
            const url = new URL(endpoint);
            if (template.method === 'GET')
                for (const [key, item] of Object.entries(values))
                    url.searchParams.set(key, String(item));
            const headers: Record<string, string> = {
                accept: 'application/json',
                ...(template.method === 'POST' ? { 'content-type': 'application/json' } : {}),
            };
            headers[template.auth.type === 'bearer' ? 'authorization' : template.auth.headerName!] =
                template.auth.type === 'bearer' ? `Bearer ${apiKey}` : apiKey;
            const response = await provider.call('search', context, (signal) =>
                provider.http.request(url.toString(), {
                    method: template.method,
                    headers,
                    ...(template.method === 'POST' ? { body: JSON.stringify(values) } : {}),
                    signal,
                    timeoutMs: Math.min(context.timeoutMs ?? 15_000, 15_000),
                    maxRedirects: 0,
                    maxBytes: 2_000_000,
                    beforeDispatch: context.beforeDispatch,
                }),
            );
            const items = pick(parseJson(response.body), template.response.resultsPath);
            if (!Array.isArray(items) || items.length > 1000)
                throw new ConnectorError('invalid_response', '搜索响应结果数组无效或过大');
            const results: SearchResult[] = [];
            let discarded = 0;
            const seen = new Set<string>();
            for (const item of items) {
                const rawUrl = pick(item, template.response.urlPath);
                const title = pick(item, template.response.titlePath);
                const snippet = pick(item, template.response.snippetPath);
                let target: string;
                try {
                    if (typeof rawUrl !== 'string' || rawUrl.length > 4000) throw new Error();
                    target = normalizeUrl(rawUrl);
                } catch {
                    discarded++;
                    continue;
                }
                if (
                    typeof title !== 'string' ||
                    !title.trim() ||
                    typeof snippet !== 'string' ||
                    seen.has(target)
                ) {
                    discarded++;
                    continue;
                }
                seen.add(target);
                if (results.length < maxResults)
                    results.push({
                        kind: 'search_snippet',
                        originalUrl: rawUrl as string,
                        url: target,
                        title: title.slice(0, 2000),
                        snippet: snippet.slice(0, 10_000),
                    });
            }
            const truncated = items.length - discarded > results.length;
            return {
                kind: 'search_results',
                mode: 'live',
                provider: 'custom_json',
                query,
                searchedAt: new Date().toISOString(),
                results,
                coverage: {
                    complete: !discarded && !truncated,
                    gaps: discarded || truncated ? ['部分候选无效、重复或超过结果上限'] : [],
                    unresponsiveEngines: [],
                    receivedResults: items.length,
                    returnedResults: results.length,
                    discardedResults: discarded,
                    totalResults: null,
                    truncated,
                },
            };
        },
    };
}
