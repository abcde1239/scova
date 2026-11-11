import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { positiveLimit, withDeadline, type HttpResponse } from './http.ts';
import { EXTRACTION_VERSION } from './page-extraction-version.ts';
import { ConnectorError, type ReadPage } from './types.ts';
import { privateJsonLine } from './private-json.ts';

export interface ExtractionContext {
    signal?: AbortSignal;
    timeoutMs?: number;
}

/** Keep synchronous DOM/Readability work outside the caller's event loop. */
export async function extractPageIsolated(
    originalUrl: string,
    response: HttpResponse,
    maxText: number,
    extractionVersion = EXTRACTION_VERSION,
    normalizedEncoding = false,
    context: ExtractionContext = {},
): Promise<ReadPage> {
    const timeoutMs = positiveLimit(context.timeoutMs ?? 5000, 15_000, '正文提取超时');
    let host: ChildProcessWithoutNullStreams | undefined;
    let ended: Promise<void> | undefined;
    const unavailable = () =>
        new ConnectorError('extraction_failed', '正文提取进程不可用，请检查 Node 和 Vite+ 安装');
    try {
        return await withDeadline(timeoutMs, context.signal, (signal) => {
            const env = Object.fromEntries(
                Object.entries(process.env).filter(([key]) =>
                    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA)$/i.test(
                        key,
                    ),
                ),
            );
            host = spawn(
                process.env.READER_NODE_EXECUTABLE ??
                    (process.versions.bun ? 'node' : process.execPath),
                [
                    fileURLToPath(
                        new URL('../../../node_modules/vite-plus/bin/vpx', import.meta.url),
                    ),
                    fileURLToPath(new URL('./page-extraction-host.mjs', import.meta.url)),
                ],
                { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true },
            );
            const child = host;
            ended = new Promise<void>((resolve) => {
                child.once('close', () => resolve());
                child.once('error', () => resolve());
            });
            return new Promise<ReadPage>((resolve, reject) => {
                let output = '';
                let settled = false;
                const finish = (page?: ReadPage, error?: unknown) => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener('abort', abort);
                    if (error) reject(error);
                    else resolve(page!);
                };
                const abort = () => {
                    child.kill();
                    finish(
                        undefined,
                        signal.reason instanceof ConnectorError
                            ? signal.reason
                            : new ConnectorError('aborted', '正文提取已停止'),
                    );
                };
                signal.addEventListener('abort', abort, { once: true });
                child.once('error', () => finish(undefined, unavailable()));
                child.stdin.on('error', () => finish(undefined, unavailable()));
                child.stderr.resume();
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk: string) => {
                    output += chunk;
                    // At most one million UTF-16 chars plus bounded metadata;
                    // JSON escapes may expand each char to six ASCII bytes.
                    if (output.length > 8 * 1024 * 1024) {
                        child.kill();
                        finish(
                            undefined,
                            new ConnectorError('response_too_large', '正文提取输出超限'),
                        );
                    }
                });
                child.once('close', () => {
                    if (settled) return;
                    try {
                        const message = JSON.parse(output);
                        if (message.ok && message.page?.kind === 'read_page')
                            finish(message.page as ReadPage);
                        else if (message.error)
                            finish(
                                undefined,
                                new ConnectorError(
                                    message.error.code,
                                    message.error.message,
                                    message.error.retryable,
                                    message.error.status,
                                ),
                            );
                        else finish(undefined, unavailable());
                    } catch {
                        finish(undefined, unavailable());
                    }
                });
                child.stdin.end(
                    privateJsonLine({
                        originalUrl,
                        response,
                        maxText,
                        extractionVersion,
                        normalizedEncoding,
                    }),
                );
                if (signal.aborted) abort();
            });
        });
    } finally {
        // An aborted CPU-bound host cannot handle an RPC shutdown request.
        // Kill it directly and wait for pipes/process exit before returning.
        if (host && host.exitCode === null) host.kill();
        await ended;
    }
}
