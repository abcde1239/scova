import { setTimeout as delay } from 'node:timers/promises';
import { normalizeUrl, positiveLimit, withDeadline } from '../http/index.ts';
import { createReaderHttpClient } from './http.ts';
import type { SafeHttpClient } from '../http/index.ts';
import { ConnectorError, PAGE_TEXT_CHAR_LIMIT } from '../types.ts';
import type { PageReader } from '../types.ts';

import { extractPageIsolated } from './extraction/process.ts';
export { EXTRACTION_VERSION, pageFingerprint } from './extraction/extract.ts';

export function createHttpPageReader(
    options: { http?: SafeHttpClient; maxTextChars?: number } = {},
): PageReader {
    const http = options.http ?? createReaderHttpClient();
    const maxText = positiveLimit(
        options.maxTextChars ?? PAGE_TEXT_CHAR_LIMIT,
        PAGE_TEXT_CHAR_LIMIT,
        '正文长度',
    );
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
                    return extractPageIsolated(originalUrl, response, maxText, undefined, false, {
                        signal,
                    });
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
