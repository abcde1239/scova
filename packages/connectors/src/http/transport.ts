import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ConnectorError } from '../types.ts';
import { decodeWebText } from '../reader/extraction/web-text.ts';
import { type HttpTransport } from './types.ts';

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
                const status = res.statusCode ?? 0;
                const consume = status >= 200 && status < 300 ? options.onBodyChunk : undefined;
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
                        return;
                    }
                    if (!consume) {
                        chunks.push(chunk);
                        return;
                    }
                    try {
                        options.signal.throwIfAborted();
                        if (consume(chunk, headers['content-type'], options.signal)) {
                            resolve({ status, headers, body: '' });
                            res.destroy();
                        }
                    } catch (error) {
                        reject(error);
                        res.destroy();
                    }
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
                        if (consume) {
                            resolve({ status, headers, body: '' });
                            return;
                        }
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
