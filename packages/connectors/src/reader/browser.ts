export { BROWSER_EXTRACTION_VERSION } from './browser/version.ts';
import { normalizeUrl, positiveLimit, withDeadline, type SafeHttpClient } from '../http/index.ts';
import { createReaderHttpClient } from './http.ts';
import { createDelegatedReader } from './runtime/delegate.ts';
import { readDiagnostics } from './diagnostics.ts';
import { ConnectorError, PAGE_TEXT_CHAR_LIMIT, type PageReader } from '../types.ts';
import { createPageExtractor } from './extraction/process.ts';
import { createPageRenderer } from './browser/render.ts';

export interface BrowserReaderOptions {
    http?: SafeHttpClient;
    maxTextChars?: number;
    renderWaitMs?: number;
}

/** Each read owns a disposable Crawlee/browser context; no cookies, storage or browser survive a Run. */
export function createPageReader(options: BrowserReaderOptions = {}): PageReader {
    const maxText = positiveLimit(
        options.maxTextChars ?? PAGE_TEXT_CHAR_LIMIT,
        PAGE_TEXT_CHAR_LIMIT,
        '正文长度',
    );
    const waitMs = positiveLimit(
        options.renderWaitMs ?? Number(process.env.READER_RENDER_WAIT_MS ?? 1000),
        5000,
        '页面渲染等待',
    );
    if (process.versions.bun)
        return createDelegatedReader({ ...options, maxTextChars: maxText, renderWaitMs: waitMs });
    const http = options.http ?? createReaderHttpClient();
    const cleanup = new Set<Promise<unknown>>();
    const controllers = new Set<AbortController>();
    // Serialize browser processes within one reader, including cleanup after a timed-out read.
    let tail: Promise<unknown> = Promise.resolve();
    let closed = false;

    const extractor = createPageExtractor();
    const render = createPageRenderer(http, maxText, waitMs, extractor.extract);

    return {
        read(originalUrl, context = {}) {
            if (closed) return Promise.reject(new ConnectorError('aborted', '网页读取器已关闭'));
            const url = normalizeUrl(originalUrl);
            const controller = new AbortController();
            controllers.add(controller);
            const previous = tail;
            const timeoutMs = Math.min(context.timeoutMs ?? 15_000, 15_000);
            const deadlineAt = performance.now() + timeoutMs;
            const diagnostics = readDiagnostics(context.onReadDiagnostic, timeoutMs);
            context = { ...context, onReadDiagnostic: diagnostics.relay };
            const result = withDeadline(
                timeoutMs,
                context.signal
                    ? AbortSignal.any([context.signal, controller.signal])
                    : controller.signal,
                (signal) => {
                    const task = (async () => {
                        await diagnostics.stage('queue', () => previous);
                        return render(originalUrl, url, context, signal, deadlineAt);
                    })();
                    cleanup.add(task);
                    tail = task.catch(() => undefined);
                    void task
                        .finally(() => {
                            cleanup.delete(task);
                            controllers.delete(controller);
                        })
                        .catch(() => undefined);
                    return task;
                },
            );
            return result.finally(() => controllers.delete(controller));
        },
        async close() {
            closed = true;
            for (const controller of controllers) controller.abort();
            await Promise.allSettled(cleanup);
            await extractor.close();
        },
    };
}
