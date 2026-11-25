import { createHash } from 'node:crypto';
import {
    createSafeHttpClient,
    isPublicIp,
    normalizeUrl,
    withDeadline,
    type SafeHttpClient,
} from '../http/index.ts';
import { parseJson, prepareProvider, record } from '../http/provider.ts';
import { ConnectorError, PAGE_TEXT_CHAR_LIMIT, type PageReader } from '../types.ts';
import { createReaderDnsResolver } from './http.ts';

const endpoint = 'https://api.firecrawl.dev/v2/scrape';
const readTimeoutMs = 15_000;

export const FIRECRAWL_EXTRACTION_VERSION = 'firecrawl/scrape-v2';

export function createFirecrawlReader(options: {
    apiKey: string;
    http?: SafeHttpClient;
    resolve?: ReturnType<typeof createReaderDnsResolver>;
}): PageReader {
    const apiKey = options.apiKey.trim();
    if (!apiKey || /[\r\n]/.test(apiKey) || apiKey.length > 8192)
        throw new ConnectorError('configuration', 'Firecrawl API 密钥无效');
    const resolve = options.resolve ?? createReaderDnsResolver();
    const provider = prepareProvider({
        http: options.http ?? createSafeHttpClient({ resolve }),
        maxAttempts: 1,
        readTimeoutMs,
    });
    async function publicHost(hostname: string, signal: AbortSignal) {
        const addresses = await resolve(hostname.replace(/^\[|\]$/g, ''), signal).catch(
            (error: unknown) => {
                if (signal.aborted) throw signal.reason;
                if (error instanceof ConnectorError) throw error;
                throw new ConnectorError('network', '网页域名解析失败', true);
            },
        );
        if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address)))
            throw new ConnectorError('unsafe_url', '网页域名未解析到纯公网地址');
    }
    return {
        async read(originalUrl, context = {}) {
            const url = normalizeUrl(originalUrl);
            const sourceHost = new URL(url).hostname;
            const timeoutMs = Math.min(context.timeoutMs ?? readTimeoutMs, readTimeoutMs);
            if (context.signal?.aborted) throw new ConnectorError('aborted', '网页读取已停止');
            if (timeoutMs < 1000) throw new ConnectorError('timeout', 'Firecrawl 读取剩余时间不足');
            return withDeadline(timeoutMs, context.signal, async (signal) => {
                await publicHost(sourceHost, signal);
                const response = await provider.call(
                    'read',
                    { ...context, signal },
                    (requestSignal) =>
                        provider.http.request(endpoint, {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/json',
                                authorization: `Bearer ${apiKey}`,
                            },
                            body: JSON.stringify({
                                url,
                                formats: ['markdown'],
                                onlyMainContent: true,
                                maxAge: 0,
                                storeInCache: false,
                                timeout: timeoutMs,
                            }),
                            signal: requestSignal,
                            timeoutMs,
                            maxRedirects: 0,
                            beforeDispatch: context.beforeDispatch,
                            onReadDiagnostic: context.onReadDiagnostic,
                        }),
                );
                const parsed = parseJson(response.body);
                if (!record(parsed) || parsed.success !== true || !record(parsed.data))
                    throw new ConnectorError('invalid_response', 'Firecrawl 未返回有效页面');
                const { markdown, metadata } = parsed.data;
                if (!record(metadata))
                    throw new ConnectorError('invalid_response', 'Firecrawl 未返回页面地址');
                if (
                    metadata.sourceURL !== undefined &&
                    (typeof metadata.sourceURL !== 'string' ||
                        normalizeUrl(metadata.sourceURL) !== url)
                )
                    throw new ConnectorError('invalid_response', 'Firecrawl 返回的请求来源不一致');
                if (
                    typeof metadata.statusCode !== 'number' ||
                    metadata.statusCode < 200 ||
                    metadata.statusCode >= 300 ||
                    typeof markdown !== 'string' ||
                    !markdown.trim()
                )
                    throw new ConnectorError('extraction_failed', 'Firecrawl 未提取到可用正文');
                const reportedUrl = metadata.url ?? metadata.sourceURL;
                if (typeof reportedUrl !== 'string')
                    throw new ConnectorError('invalid_response', 'Firecrawl 未返回页面地址');
                const finalUrl = normalizeUrl(reportedUrl);
                const finalHost = new URL(finalUrl).hostname;
                if (finalHost !== sourceHost) await publicHost(finalHost, signal);
                const text = markdown
                    .slice(0, PAGE_TEXT_CHAR_LIMIT)
                    .replace(/[\uD800-\uDBFF]$/, '');
                return {
                    kind: 'read_page',
                    mode: 'live',
                    originalUrl,
                    fetchedUrl: finalUrl,
                    url: finalUrl,
                    title:
                        typeof metadata.title === 'string'
                            ? metadata.title.slice(0, 2000)
                            : finalUrl,
                    text,
                    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
                    extractionVersion: FIRECRAWL_EXTRACTION_VERSION,
                    collectedAt: new Date().toISOString(),
                    truncated: text.length < markdown.length,
                    untrusted: true,
                };
            });
        },
    };
}
