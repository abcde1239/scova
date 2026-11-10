import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { normalizeUrl, withDeadline, type HttpOptions } from './http.ts';
import { createReaderHttpClient } from './reader-http.ts';
import { ConnectorError, type CallContext, type PageReader, type ReadPage } from './types.ts';
import type { BrowserReaderOptions } from './browser-reader.ts';

interface WireError {
    code: ConnectorError['code'];
    message: string;
    retryable: boolean;
    status?: number;
}
interface HostMessage {
    type: 'ready' | 'result' | 'error' | 'http' | 'beforeAttempt' | 'beforeDispatch';
    id: number;
    readId: number;
    url: string;
    options: HttpOptions;
    previousFailure?: WireError;
    result: ReadPage;
    error: WireError;
}
const hostFailure = () =>
    new ConnectorError('extraction_failed', 'Node 网页读取进程不可用，请检查 Node 和 Vite+ 安装');
function unpack(error: WireError): ConnectorError {
    return new ConnectorError(error.code, error.message, error.retryable, error.status);
}
function pack(error: unknown): WireError {
    if (!(error instanceof ConnectorError))
        return { code: 'extraction_failed', message: '网页读取回调失败', retryable: false };
    return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        status: error.status,
    };
}

/** Node owns Crawlee/Playwright; only HTTP and trusted Run callbacks cross the private pipe. */
export function createDelegatedReader(options: BrowserReaderOptions): PageReader {
    const http = options.http ?? createReaderHttpClient();
    const calls = new Map<
        number,
        {
            context: CallContext;
            signal: AbortSignal;
            resolve: (page: ReadPage) => void;
            reject: (error: unknown) => void;
        }
    >();
    const inFlight = new Set<Promise<void>>();
    let host: ChildProcessWithoutNullStreams | undefined;
    let ready: Promise<void> | undefined;
    let ended: Promise<void> = Promise.resolve();
    let failed: ConnectorError | undefined;
    let closed = false;
    let closing: Promise<void> | undefined;
    let sequence = 0;

    function send(message: object) {
        if (!host?.stdin.writable || failed) return;
        host.stdin.write(`${JSON.stringify(message)}\n`, () => undefined);
    }
    function start(): Promise<void> {
        return (ready ??= new Promise<void>((resolve, reject) => {
            // Use the repository's Vite+ loader for TypeScript; no global shim or shell invocation.
            const env = Object.fromEntries(
                Object.entries(process.env).filter(([key]) =>
                    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|DISPLAY|FONTCONFIG_PATH|PLAYWRIGHT_BROWSERS_PATH|READER_RENDER_WAIT_MS|READER_CHROMIUM_SANDBOX)$/i.test(
                        key,
                    ),
                ),
            );
            host = spawn(
                process.env.READER_NODE_EXECUTABLE ?? 'node',
                [
                    fileURLToPath(
                        new URL('../../../node_modules/vite-plus/bin/vpx', import.meta.url),
                    ),
                    fileURLToPath(new URL('./bun-reader-host.mjs', import.meta.url)),
                ],
                { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true },
            );
            const fail = () => {
                failed ??= hostFailure();
                reject(failed);
                for (const call of calls.values()) call.reject(failed);
                calls.clear();
            };
            ended = new Promise<void>((finish) => {
                host!.once('error', () => {
                    fail();
                    finish();
                });
                host!.once('exit', () => {
                    fail();
                    finish();
                });
            });
            host.stdin.on('error', fail);
            // Never surface browser diagnostics that might include source URLs or text.
            host.stderr.resume();
            const lines = createInterface({ input: host.stdout });
            lines.on('line', (line) => {
                let message: HostMessage;
                try {
                    message = JSON.parse(line);
                } catch {
                    fail();
                    return;
                }
                if (message.type === 'ready') {
                    resolve();
                    return;
                }
                if (message.type === 'result' || message.type === 'error') {
                    const call = calls.get(message.id);
                    calls.delete(message.id);
                    if (message.type === 'result') call?.resolve(message.result);
                    else call?.reject(unpack(message.error));
                    return;
                }
                const answer = (async () => {
                    try {
                        const call = calls.get(message.readId);
                        if (!call || call.signal.aborted || closed)
                            throw new ConnectorError('aborted', '网页读取已停止');
                        let response;
                        if (message.type === 'http') {
                            response = await http.request(message.url, {
                                ...message.options,
                                signal: call.signal,
                            });
                        } else if (message.type === 'beforeAttempt') {
                            await call.context.beforeAttempt?.(
                                'read',
                                message.previousFailure
                                    ? unpack(message.previousFailure)
                                    : undefined,
                            );
                        } else if (message.type === 'beforeDispatch') {
                            await call.context.beforeDispatch?.();
                        } else throw hostFailure();
                        if (call.signal.aborted || closed)
                            throw new ConnectorError('aborted', '网页读取已停止');
                        send({ type: 'response', id: message.id, ok: true, response });
                    } catch (error) {
                        if (message.type === 'beforeAttempt' || message.type === 'beforeDispatch') {
                            // Lease/repository errors belong to the trusted parent. Preserve their
                            // identity so Worker can classify budget/CAS failures after the RPC.
                            calls.get(message.readId)?.reject(error);
                            send({ type: 'abort', id: message.readId });
                        }
                        send({ type: 'response', id: message.id, ok: false, error: pack(error) });
                    }
                })();
                inFlight.add(answer);
                void answer.finally(() => inFlight.delete(answer));
            });
            send({
                type: 'init',
                maxTextChars: options.maxTextChars,
                renderWaitMs: options.renderWaitMs,
            });
        }));
    }
    const controllers = new Set<AbortController>();
    return {
        read(originalUrl, context = {}) {
            if (closed) return Promise.reject(new ConnectorError('aborted', '网页读取器已关闭'));
            normalizeUrl(originalUrl);
            const controller = new AbortController();
            controllers.add(controller);
            const id = ++sequence;
            const started = Date.now();
            const timeout = Math.min(context.timeoutMs ?? 15_000, 15_000);
            return withDeadline(
                timeout,
                context.signal
                    ? AbortSignal.any([context.signal, controller.signal])
                    : controller.signal,
                async (signal) => {
                    const abort = () => {
                        send({ type: 'abort', id });
                        calls.get(id)?.reject(new ConnectorError('aborted', '网页读取已停止'));
                        calls.delete(id);
                    };
                    signal.addEventListener('abort', abort, { once: true });
                    try {
                        await start();
                        if (signal.aborted) throw new ConnectorError('aborted', '网页读取已停止');
                        if (failed) throw failed;
                        return await new Promise<ReadPage>((resolve, reject) => {
                            calls.set(id, {
                                context,
                                signal: AbortSignal.any([signal, controller.signal]),
                                resolve,
                                reject,
                            });
                            send({
                                type: 'read',
                                id,
                                originalUrl,
                                timeoutMs: Math.max(1, timeout - (Date.now() - started)),
                            });
                        });
                    } finally {
                        signal.removeEventListener('abort', abort);
                    }
                },
            ).finally(() => {
                controller.abort();
                controllers.delete(controller);
                calls.delete(id);
            });
        },
        close() {
            return (closing ??= (async () => {
                closed = true;
                for (const controller of controllers) controller.abort();
                if (!host) return;
                send({ type: 'close' });
                // A failed host must never hold Worker shutdown indefinitely.
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        ended,
                        new Promise<void>((resolve) => {
                            timer = setTimeout(() => {
                                host?.kill();
                                resolve();
                            }, 8000);
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                }
                await Promise.allSettled(inFlight);
            })());
        },
    };
}
