import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { normalizeUrl, positiveLimit, withDeadline } from './http.ts';
import { createReaderHttpClient } from './reader-http.ts';
import type { SafeHttpClient } from './http.ts';
import { ConnectorError } from './types.ts';
import type { PageReader } from './types.ts';
import { extractPublication } from './dates.ts';

export const EXTRACTION_VERSION = 'readability-0.6.0/scova-text-v1';

export function pageFingerprint(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createPageReader(
    options: { http?: SafeHttpClient; maxTextChars?: number } = {},
): PageReader {
    const http = options.http ?? createReaderHttpClient();
    const maxText = positiveLimit(options.maxTextChars ?? 100_000, 200_000, '正文长度');
    const origins = new Map<string, Promise<void>>();
    return {
        read(originalUrl, context = {}) {
            const url = normalizeUrl(originalUrl);
            const origin = new URL(url).origin;
            const previous = origins.get(origin) ?? Promise.resolve();
            let release!: () => void;
            const current = new Promise<void>((resolve) => {
                release = resolve;
            });
            const tail = previous.then(() => current);
            origins.set(origin, tail);
            const result = withDeadline(
                Math.min(context.timeoutMs ?? 15_000, 15_000),
                context.signal,
                async (signal) => {
                    await previous;
                    if (signal.aborted) throw signal.reason;
                    const request = async (previousFailure?: ConnectorError) => {
                        await context.beforeAttempt?.('read', previousFailure);
                        if (signal.aborted) throw signal.reason;
                        const response = await http.request(url, {
                            signal,
                            maxBytes: 2 * 1024 * 1024,
                            maxRedirects: 3,
                        });
                        if (response.status < 200 || response.status >= 300)
                            throw new ConnectorError(
                                'http',
                                '网页采集失败',
                                response.status === 429 || response.status >= 500,
                                response.status,
                            );
                        return response;
                    };
                    let response;
                    try {
                        response = await request();
                    } catch (error) {
                        // One retry shares the original deadline and reserves another page attempt.
                        // Never retry access restrictions, rate limiting, parsing or security failures.
                        if (
                            !(error instanceof ConnectorError) ||
                            !error.retryable ||
                            !(
                                error.code === 'network' ||
                                (error.code === 'http' && (error.status ?? 0) >= 500)
                            )
                        )
                            throw error;
                        await delay(200, undefined, { signal });
                        response = await request(error);
                    }
                    const contentType = response.headers['content-type'] ?? '';
                    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(contentType))
                        throw new ConnectorError('invalid_response', '网页不是 HTML 正文');
                    const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
                    if (charset && !/^utf-?8$/i.test(charset))
                        throw new ConnectorError('invalid_response', '网页字符编码不支持');
                    // Reader extracts text, not rendered styles. Modern source CSS can be valid
                    // in browsers while unsupported by jsdom's CSS parser. Keep other diagnostics.
                    const virtualConsole = new VirtualConsole();
                    virtualConsole.on('jsdomError', (error) => {
                        if (Reflect.get(error, 'type') !== 'css parsing')
                            console.error(error.message);
                    });
                    const dom = new JSDOM(response.body, { url: response.url, virtualConsole });
                    try {
                        const document = dom.window.document;
                        if (document.getElementsByTagName('*').length > 20_000)
                            throw new ConnectorError('extraction_failed', '网页节点数超过提取限制');
                        const contentMeta = [...document.querySelectorAll('meta[http-equiv]')].find(
                            (meta) =>
                                meta.getAttribute('http-equiv')?.toLowerCase() === 'content-type',
                        );
                        const declared =
                            document.querySelector('meta[charset]')?.getAttribute('charset') ??
                            contentMeta
                                ?.getAttribute('content')
                                ?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
                        if (declared && !/^utf-?8$/i.test(declared))
                            throw new ConnectorError(
                                'invalid_response',
                                '网页声明的字符编码不支持',
                            );
                        const publication = extractPublication(document);
                        document
                            .querySelectorAll('script,style,iframe,object,embed,form,noscript')
                            .forEach((node) => node.remove());
                        const article = new Readability(document, {
                            charThreshold: 0,
                            maxElemsToParse: 20_000,
                        }).parse();
                        const fullText = article?.textContent?.replace(/\s+/g, ' ').trim();
                        if (!fullText)
                            throw new ConnectorError('extraction_failed', '网页没有可提取正文');
                        const text = fullText.slice(0, maxText);
                        return {
                            kind: 'read_page' as const,
                            mode: 'live' as const,
                            originalUrl,
                            fetchedUrl: response.url,
                            url: normalizeUrl(response.url),
                            title: article?.title?.trim() ?? '',
                            text,
                            contentHash: pageFingerprint(text),
                            extractionVersion: EXTRACTION_VERSION,
                            collectedAt: new Date().toISOString(),
                            truncated: fullText.length > maxText,
                            publication,
                            untrusted: true as const,
                        };
                    } finally {
                        dom.window.close();
                    }
                },
            );
            return result.finally(() => {
                release();
                if (origins.get(origin) === tail)
                    void tail.then(() => {
                        if (origins.get(origin) === tail) origins.delete(origin);
                    });
            });
        },
    };
}
