import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { positiveLimit, withDeadline, type HttpResponse } from '../../http/index.ts';
import { EXTRACTION_VERSION } from './version.ts';
import { ConnectorError, type ReadPage } from '../../types.ts';
import { privateJsonLine } from '../runtime/json.ts';

export interface ExtractionContext {
    signal?: AbortSignal;
    timeoutMs?: number;
}

function unavailable() {
    return new ConnectorError('extraction_failed', '正文提取进程不可用，请检查 Node 和 Vite+ 安装');
}

function startHost() {
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA)$/i.test(key),
        ),
    );
    const child = spawn(
        process.env.READER_NODE_EXECUTABLE ?? (process.versions.bun ? 'node' : process.execPath),
        [
            fileURLToPath(
                new URL('../../../../../node_modules/vite-plus/bin/vpx', import.meta.url),
            ),
            fileURLToPath(new URL('./host.mjs', import.meta.url)),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true },
    );
    const failure = new AbortController();
    const fail = () => failure.abort(unavailable());
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    const ended = new Promise<void>((resolve) =>
        child.once('close', () => {
            fail();
            resolve();
        }),
    );
    return { child, ended, failure };
}

function requestFrame(host: ReturnType<typeof startHost>, frame: string, signal: AbortSignal) {
    return new Promise<ReadPage | ConnectorError>((resolve, reject) => {
        let output = '';
        const cleanup = () => {
            host.child.stdout.off('data', receive);
            signal.removeEventListener('abort', abort);
        };
        const abort = () => {
            cleanup();
            reject(signal.reason);
        };
        function receive(chunk: string) {
            output += chunk;
            // A million UTF-16 characters may use six JSON escape bytes each.
            if (output.length > 8 * 1024 * 1024) {
                cleanup();
                reject(new ConnectorError('response_too_large', '正文提取输出超限'));
                return;
            }
            if (!chunk.endsWith('\n')) return;
            cleanup();
            try {
                const message = JSON.parse(output);
                if (message.ok && message.page?.kind === 'read_page') resolve(message.page);
                else if (message.error) {
                    const { code, message: detail, retryable, status } = message.error;
                    resolve(new ConnectorError(code, detail, retryable, status));
                } else reject(unavailable());
            } catch {
                reject(unavailable());
            }
        }
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        host.child.stdout.on('data', receive);
        host.child.stdin.write(frame);
    });
}

/** A serialized Reader owns one interruptible Node parser. Idle readers release it. */
export function createPageExtractor() {
    let host: ReturnType<typeof startHost> | undefined;
    let reaped = Promise.resolve();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let closed = false;

    function stopHost() {
        clearTimeout(idle);
        if (host) {
            reaped = host.ended;
            host.child.kill('SIGKILL');
            host = undefined;
        }
        return reaped;
    }

    async function extract(
        originalUrl: string,
        response: HttpResponse,
        maxText: number,
        extractionVersion = EXTRACTION_VERSION,
        normalizedEncoding = false,
        context: ExtractionContext = {},
    ): Promise<ReadPage> {
        const timeoutMs = positiveLimit(context.timeoutMs ?? 5000, 15_000, '正文提取超时');
        if (closed) throw new ConnectorError('aborted', '正文提取器已关闭');
        if (busy) throw new ConnectorError('extraction_failed', '正文提取器正在使用');
        busy = true;
        clearTimeout(idle);
        let result: ReadPage | ConnectorError;
        try {
            if (host?.failure.signal.aborted) await stopHost();
            await reaped;
            if (closed) throw new ConnectorError('aborted', '正文提取器已关闭');
            result = await withDeadline(timeoutMs, context.signal, async (signal) => {
                const current = (host ??= startHost());
                return requestFrame(
                    current,
                    privateJsonLine({
                        originalUrl,
                        response,
                        maxText,
                        extractionVersion,
                        normalizedEncoding,
                    }),
                    AbortSignal.any([signal, current.failure.signal]),
                );
            });
            idle = setTimeout(stopHost, 10_000);
            idle.unref();
        } catch (error) {
            await stopHost();
            throw error;
        } finally {
            busy = false;
        }
        if (result instanceof ConnectorError) throw result;
        return result;
    }
    return {
        extract,
        close() {
            closed = true;
            return stopHost();
        },
    };
}

/** Independent callers can extract concurrently without sharing a parser. */
export async function extractPageIsolated(
    ...args: Parameters<ReturnType<typeof createPageExtractor>['extract']>
) {
    const extractor = createPageExtractor();
    try {
        return await extractor.extract(...args);
    } finally {
        await extractor.close();
    }
}
