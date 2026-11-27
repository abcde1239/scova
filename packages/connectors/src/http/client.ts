import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ConnectorError } from '../types.ts';
import { readDiagnostics } from '../reader/diagnostics.ts';
import {
    type ResolvedAddress,
    validatePublicUrl,
    isPublicIp,
    interleaveAddressFamilies,
} from './address.ts';
import {
    type HttpTransport,
    type SafeHttpClient,
    type TransportOptions,
    type HttpResponse,
} from './types.ts';
import { positiveLimit, withDeadline } from './deadline.ts';
import { nodeHttpTransport } from './transport.ts';

export function createSafeHttpClient(
    config: {
        resolve?: (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;
        transport?: HttpTransport;
        maxTimeoutMs?: number;
        /** Bounded IP connection fallback for idempotent public reads; POST is never replayed. */
        maxAddressAttempts?: number;
        /** Bound connection/headers for each address; the body retains the overall deadline. */
        addressTimeoutMs?: number;
        /** A received body must keep making progress; omitted for model/search transports. */
        bodyIdleTimeoutMs?: number;
    } = {},
): SafeHttpClient {
    const maxTimeoutMs = positiveLimit(config.maxTimeoutMs ?? 15_000, 120_000, 'HTTP超时上限');
    const maxAddressAttempts = positiveLimit(config.maxAddressAttempts ?? 1, 3, '地址尝试上限');
    const addressTimeoutMs = positiveLimit(config.addressTimeoutMs ?? 4000, 4000, '单地址超时');
    const bodyIdleTimeoutMs =
        config.bodyIdleTimeoutMs === undefined
            ? undefined
            : positiveLimit(config.bodyIdleTimeoutMs, 5000, '正文传输空闲超时');
    const resolver: NonNullable<typeof config.resolve> =
        config.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
    const transport = config.transport ?? nodeHttpTransport;
    const originTails = new Map<string, Promise<void>>();
    const send = async (
        url: URL,
        options: TransportOptions,
        attemptTimeoutMs?: number,
        diagnostics = readDiagnostics(undefined, 15_000),
        beforeDispatch?: () => Promise<void>,
    ) => {
        const origin = url.origin;
        const previous = originTails.get(origin) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        originTails.set(origin, tail);
        let stopWaiting: (() => void) | undefined;
        try {
            // Waiting for an earlier safe request counts towards the original
            // overall deadline, but is not a failed IP connection attempt.
            await diagnostics.stage('queue', () =>
                Promise.race([
                    previous,
                    new Promise<never>((_resolve, reject) => {
                        stopWaiting = () => reject(options.signal.reason);
                        if (options.signal.aborted) stopWaiting();
                        else options.signal.addEventListener('abort', stopWaiting, { once: true });
                    }),
                ]),
            );
            if (options.signal.aborted) throw options.signal.reason;
            if (beforeDispatch) await diagnostics.stage('dispatch', () => beforeDispatch());
            if (options.signal.aborted) throw options.signal.reason;
            const headersDone = diagnostics.begin('headers');
            let bodyDone: ((error?: unknown) => void) | undefined;
            const traced = {
                ...options,
                onResponseStarted: () => {
                    headersDone();
                    bodyDone ??= diagnostics.begin('body');
                    options.onResponseStarted?.();
                },
            };
            const request = async (transportOptions: TransportOptions) => {
                try {
                    const value = await transport(url, transportOptions);
                    headersDone();
                    bodyDone?.();
                    return value;
                } catch (error) {
                    headersDone(error);
                    bodyDone?.(error);
                    throw error;
                }
            };
            if (!attemptTimeoutMs) return await request(traced);
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort: (() => void) | undefined;
            const stopped = new Promise<never>((_resolve, reject) => {
                const stop = (error: unknown) => {
                    controller.abort(error);
                    reject(error);
                };
                onAbort = () => stop(options.signal.reason);
                options.signal.addEventListener('abort', onAbort, { once: true });
                timer = setTimeout(
                    () => stop(new ConnectorError('timeout', '来源连接或响应头超时', true)),
                    attemptTimeoutMs,
                );
            });
            try {
                return await Promise.race([
                    stopped,
                    request({
                        ...traced,
                        signal: controller.signal,
                        onResponseStarted: () => {
                            // Once the server has responded, a slow successful body
                            // must not be restarted on the next IP. Size and the
                            // unchanged caller deadline still bound every byte.
                            clearTimeout(timer);
                            traced.onResponseStarted();
                        },
                    }),
                ]);
            } finally {
                clearTimeout(timer);
                if (onAbort) options.signal.removeEventListener('abort', onAbort);
            }
        } finally {
            if (stopWaiting) options.signal.removeEventListener('abort', stopWaiting);
            release();
            // A cancelled queued request can finish before its predecessor.
            // Keep its tail registered until the entire predecessor chain ends.
            void tail.then(() => {
                if (originTails.get(origin) === tail) originTails.delete(origin);
            });
        }
    };
    return {
        request(value, options = {}) {
            const diagnostics = readDiagnostics(
                options.onReadDiagnostic,
                Math.min(options.timeoutMs ?? 15_000, maxTimeoutMs),
            );
            const maxBytes = positiveLimit(
                options.maxBytes ?? 2 * 1024 * 1024,
                2 * 1024 * 1024,
                '响应大小',
            );
            const maxRedirects = options.maxRedirects ?? 3;
            if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) {
                throw new ConnectorError('configuration', '重定向上限无效');
            }
            return withDeadline(
                Math.min(options.timeoutMs ?? 15_000, maxTimeoutMs),
                options.signal,
                async (signal) => {
                    let url = validatePublicUrl(value);
                    let headers = { ...options.headers };
                    for (let hop = 0; ; hop++) {
                        const hostname = url.hostname.replace(/^\[|\]$/g, '');
                        let addresses: ResolvedAddress[];
                        try {
                            addresses = isIP(hostname)
                                ? [{ address: hostname, family: isIP(hostname) }]
                                : await diagnostics.stage('dns', () => resolver(hostname, signal));
                        } catch (error) {
                            if (error instanceof ConnectorError) throw error;
                            throw new ConnectorError('network', '来源域名解析失败', true);
                        }
                        if (
                            !addresses.length ||
                            addresses.some(
                                (a) => !isPublicIp(a.address) || isIP(a.address) !== a.family,
                            )
                        ) {
                            throw new ConnectorError('unsafe_url', '域名解析包含非公共网络地址');
                        }
                        if (signal.aborted) throw signal.reason;
                        let response: Omit<HttpResponse, 'url'> | undefined;
                        const candidates = interleaveAddressFamilies(addresses).slice(
                            0,
                            (options.method ?? 'GET') === 'GET' ? maxAddressAttempts : 1,
                        );
                        for (const [index, address] of candidates.entries()) {
                            try {
                                response = await send(
                                    url,
                                    {
                                        method: options.method ?? 'GET',
                                        headers,
                                        body: options.body,
                                        signal,
                                        maxBytes,
                                        responseEncoding: options.responseEncoding,
                                        onBodyChunk: options.onBodyChunk,
                                        bodyIdleTimeoutMs:
                                            (options.method ?? 'GET') === 'GET'
                                                ? bodyIdleTimeoutMs
                                                : undefined,
                                        address,
                                    },
                                    (options.method ?? 'GET') === 'GET' && maxAddressAttempts > 1
                                        ? addressTimeoutMs
                                        : undefined,
                                    diagnostics,
                                    options.beforeDispatch,
                                );
                                break;
                            } catch (error) {
                                if (signal.aborted) throw signal.reason;
                                const failure =
                                    error instanceof ConnectorError
                                        ? error
                                        : new ConnectorError('network', '外部连接失败', true);
                                if (
                                    !['network', 'timeout'].includes(failure.code) ||
                                    index === candidates.length - 1
                                )
                                    throw failure;
                            }
                        }
                        if (!response)
                            throw new ConnectorError('network', '没有可连接的公网地址', true);
                        if (Buffer.byteLength(response.body, 'utf8') > maxBytes)
                            throw new ConnectorError('response_too_large', '响应超过下载限制');
                        if ([301, 302, 303, 307, 308].includes(response.status)) {
                            if (
                                hop >= maxRedirects ||
                                (options.method ?? 'GET') !== 'GET' ||
                                !response.headers.location
                            ) {
                                throw new ConnectorError('unsafe_url', '重定向不允许或超过上限');
                            }
                            const next = validatePublicUrl(
                                new URL(response.headers.location, url).toString(),
                            );
                            if (url.protocol === 'https:' && next.protocol !== 'https:')
                                throw new ConnectorError('unsafe_url', '不允许降级重定向');
                            // Never forward credentials or caller-controlled Host/Cookie through a redirect.
                            headers = Object.fromEntries(
                                Object.entries(headers).filter(
                                    ([key]) =>
                                        ![
                                            'authorization',
                                            'cookie',
                                            'proxy-authorization',
                                            'host',
                                        ].includes(key.toLowerCase()),
                                ),
                            );
                            url = next;
                            continue;
                        }
                        return { ...response, url: url.toString() };
                    }
                },
            );
        },
    };
}
