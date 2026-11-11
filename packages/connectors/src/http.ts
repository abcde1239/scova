import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ConnectorError, type ReadDiagnostic } from './types.ts';
import { readDiagnostics } from './read-diagnostics.ts';
import { decodeWebText } from './web-text.ts';

export interface ResolvedAddress {
    address: string;
    family: number;
}

/** Preserve DNS preference within each family without spending every attempt on one family. */
function interleaveAddressFamilies(addresses: ResolvedAddress[]): ResolvedAddress[] {
    const unique = [...new Map(addresses.map((address) => [address.address, address])).values()];
    const preferred = unique[0]?.family;
    const first = unique.filter((address) => address.family === preferred);
    const second = unique.filter((address) => address.family !== preferred);
    const result: ResolvedAddress[] = [];
    for (let index = 0; index < Math.max(first.length, second.length); index++) {
        if (first[index]) result.push(first[index]);
        if (second[index]) result.push(second[index]);
    }
    return result;
}

export interface HttpResponse {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface HttpOptions {
    onReadDiagnostic?: (event: ReadDiagnostic) => void;
    responseEncoding?: 'web-text';
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
}

export interface TransportOptions {
    /** Only Reader enables this; a progressing body keeps the unchanged overall deadline. */
    bodyIdleTimeoutMs?: number;
    responseEncoding?: 'web-text';
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    maxBytes: number;
    address: ResolvedAddress;
    /** Trusted transport callback; only response headers end the IP connection budget. */
    onResponseStarted?: () => void;
}

/** A privileged injection point: production callers should use the default pinned transport. */
export type HttpTransport = (
    url: URL,
    options: TransportOptions,
) => Promise<Omit<HttpResponse, 'url'>>;

export interface SafeHttpClient {
    request(url: string, options?: HttpOptions): Promise<HttpResponse>;
}

export function isPublicIp(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 &&
                ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113)
        );
    }
    if (isIP(address) !== 6 || address.includes('.')) return false;
    const parts = address.toLowerCase().split(':');
    const first = Number.parseInt(parts[0] || '0', 16);
    const second = Number.parseInt(parts[1] || '0', 16);
    // Only global unicast, excluding transition, protocol-assignment and documentation ranges.
    return (
        first >= 0x2000 &&
        first <= 0x3fff &&
        first !== 0x2002 &&
        !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
        !(first === 0x3fff && second < 0x1000)
    );
}

export function validatePublicUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new ConnectorError('unsafe_url', '来源 URL 无效');
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    ) {
        throw new ConnectorError('unsafe_url', '来源协议、凭据或端口不允许');
    }
    const hostname = url.hostname
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '')
        .toLowerCase();
    if (
        !hostname ||
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        (isIP(hostname) !== 0 && !isPublicIp(hostname))
    ) {
        throw new ConnectorError('unsafe_url', '来源地址不是公共网络地址');
    }
    url.hash = '';
    return url;
}

export function normalizeUrl(value: string): string {
    const url = validatePublicUrl(value);
    // Snapshot keys before deletion: the live iterator would skip adjacent tracking keys.
    const keys = Array.from(url.searchParams.keys());
    for (const key of keys) {
        if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid)$/i.test(key))
            url.searchParams.delete(key);
    }
    return url.toString();
}

export function positiveLimit(value: number, max: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new ConnectorError('configuration', `${label} 超出允许范围`);
    }
    return value;
}

export async function withDeadline<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    positiveLimit(timeoutMs, 300_000, '超时');
    if (signal?.aborted) throw new ConnectorError('aborted', '调用已取消');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        const stop = (error: ConnectorError) => {
            controller.abort(error);
            reject(error);
        };
        onAbort = () => stop(new ConnectorError('aborted', '调用已取消'));
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => stop(new ConnectorError('timeout', '调用超时', true)), timeoutMs);
    });
    try {
        return await Promise.race([operation(controller.signal), stopped]);
    } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
}

export const nodeHttpTransport: HttpTransport = (url, options) =>
    new Promise((resolve, reject) => {
        const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const pinned = options.address;
        const req = request(
            url,
            {
                method: options.method,
                // Bun 1.3.x的IP固定连接需要显式Host才能按原域名校验证书。
                // Host只取URL，不允许调用方覆盖；TLS证书验证仍保持开启。
                headers: {
                    'accept-encoding': 'identity',
                    ...Object.fromEntries(
                        Object.entries(options.headers).filter(
                            ([name]) => name.toLowerCase() !== 'host',
                        ),
                    ),
                    host: url.host,
                },
                signal: options.signal,
                agent: false,
                // Keep the URL hostname for Host/TLS/SNI, but never perform a second DNS lookup.
                lookup: (_hostname, lookupOptions, callback) => {
                    if (lookupOptions.all) callback(null, [pinned]);
                    else callback(null, pinned.address, pinned.family);
                },
            },
            (res) => {
                options.onResponseStarted?.();
                const headers: Record<string, string> = {};
                for (const [name, value] of Object.entries(res.headers)) {
                    if (value !== undefined)
                        headers[name] = Array.isArray(value) ? value.join(', ') : value;
                }
                if (
                    !options.responseEncoding &&
                    headers['content-encoding'] &&
                    headers['content-encoding'] !== 'identity'
                ) {
                    res.destroy();
                    reject(new ConnectorError('invalid_response', '不支持压缩响应'));
                    return;
                }
                if (Number(headers['content-length']) > options.maxBytes) {
                    res.destroy();
                    reject(new ConnectorError('response_too_large', '响应超过下载限制'));
                    return;
                }
                const chunks: Buffer[] = [];
                let bytes = 0;
                let bodyTimer: ReturnType<typeof setTimeout> | undefined;
                const progress = () => {
                    clearTimeout(bodyTimer);
                    if (options.bodyIdleTimeoutMs)
                        bodyTimer = setTimeout(() => {
                            const error = new ConnectorError('timeout', '来源响应体停止传输', true);
                            reject(error);
                            res.destroy(error);
                        }, options.bodyIdleTimeoutMs);
                };
                progress();
                res.on('data', (chunk: Buffer) => {
                    progress();
                    bytes += chunk.length;
                    if (bytes > options.maxBytes) {
                        const error = new ConnectorError('response_too_large', '响应超过下载限制');
                        reject(error);
                        res.destroy(error);
                    } else chunks.push(chunk);
                });
                res.on('error', reject);
                res.on('aborted', () =>
                    reject(new ConnectorError('network', '响应流提前中断', true)),
                );
                res.on('close', () => {
                    clearTimeout(bodyTimer);
                    if (!res.complete)
                        reject(new ConnectorError('network', '响应流未完整接收', true));
                });
                res.on('end', () => {
                    clearTimeout(bodyTimer);
                    try {
                        if (options.responseEncoding === 'web-text') {
                            // Redirect/error payloads are never rendered. Preserve status and Location
                            // even when an upstream sends an empty or binary diagnostic body.
                            if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                                resolve({ status: res.statusCode ?? 0, headers, body: '' });
                                return;
                            }
                            resolve({
                                status: res.statusCode ?? 0,
                                ...decodeWebText(Buffer.concat(chunks), headers, options.maxBytes),
                            });
                            return;
                        }
                        const body = new TextDecoder('utf-8', { fatal: true }).decode(
                            Buffer.concat(chunks),
                        );
                        resolve({ status: res.statusCode ?? 0, headers, body });
                    } catch (error) {
                        reject(
                            error instanceof ConnectorError
                                ? error
                                : new ConnectorError('invalid_response', '响应不是有效 UTF-8 文本'),
                        );
                    }
                });
            },
        );
        req.on('error', (error) =>
            reject(
                error instanceof ConnectorError
                    ? error
                    : new ConnectorError(
                          options.signal.aborted ? 'aborted' : 'network',
                          '外部连接失败',
                          !options.signal.aborted,
                      ),
            ),
        );
        req.end(options.body);
    });

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
