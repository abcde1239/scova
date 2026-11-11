import { setTimeout as delay } from 'node:timers/promises';
import type { PlaywrightCrawler } from '@crawlee/playwright';
import type { BrowserContext } from 'playwright';
import {
    normalizeUrl,
    positiveLimit,
    withDeadline,
    type SafeHttpClient,
    type HttpResponse,
} from './http.ts';
import { createReaderHttpClient } from './reader-http.ts';
import { extractPageIsolated } from './page-extraction-process.ts';
import { isExtractionCapacityError } from './page-extraction-capacity.ts';
import { EXTRACTION_VERSION } from './page-extraction-version.ts';
import { pageIsLoading } from './page-readiness.ts';
import { pageHasPendingData } from './page-data-readiness.ts';
import { pageSnapshot } from './page-snapshot.ts';
import { createDelegatedReader } from './browser-delegate.ts';
import { readDiagnostics } from './read-diagnostics.ts';
import {
    ConnectorError,
    PAGE_TEXT_CHAR_LIMIT,
    type CallContext,
    type PageReader,
    type ReadPage,
    type PageCollection,
} from './types.ts';

export const BROWSER_EXTRACTION_VERSION = `crawlee-3.18.2/playwright-1.64.1/${EXTRACTION_VERSION}`;
const PAGE_BYTES = 2 * 1024 * 1024;
const TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_REQUESTS = 32;
const htmlType = (type: string) => /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(type);

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

    async function render(
        originalUrl: string,
        url: string,
        context: CallContext,
        signal: AbortSignal,
        deadlineAt: number,
    ): Promise<ReadPage> {
        const diagnostics = readDiagnostics(
            context.onReadDiagnostic,
            Math.max(0, deadlineAt - performance.now()),
        );
        const callerSignal = signal;
        const renderBudget = new AbortController();
        signal = AbortSignal.any([signal, renderBudget.signal]);
        let crawler: PlaywrightCrawler | undefined;
        let browserContext: BrowserContext | undefined;
        let fatal: unknown;
        let callbackFailure: { error: unknown } | undefined;
        let output: ReadPage | undefined;
        let downloaded = 0;
        let requests = 1;
        let mainServed = false;
        let resourceTail: Promise<unknown> = Promise.resolve();
        const inFlight = new Set<Promise<unknown>>();
        const resources = new AbortController();
        const resourceSignal = AbortSignal.any([signal, resources.signal]);
        const limitations = new Set<PageCollection['limitations'][number]>();
        let resourceTimer: ReturnType<typeof setTimeout> | undefined;
        let renderTimer: ReturnType<typeof setTimeout> | undefined;
        let staticPartial: ReadPage | undefined;
        let finishRender: ((error?: unknown) => void) | undefined;
        const retainedPartial = (): ReadPage => ({
            ...staticPartial!,
            collection: {
                version: 1,
                method: 'html',
                complete: false,
                limitations: [
                    ...new Set<PageCollection['limitations'][number]>([
                        ...(staticPartial?.collection?.limitations ?? []),
                        'render_timeout',
                    ]),
                ].sort(),
            },
        });
        let resourceOpen = true;
        const stopResources = () => {
            resourceOpen = false;
            resources.abort();
        };
        const abort = () => {
            crawler?.stop();
            // Route handlers also carry this signal; closing the context interrupts page JavaScript.
            void browserContext?.close().catch(() => undefined);
        };
        signal.addEventListener('abort', abort, { once: true });
        const check = () => {
            if (signal.aborted) throw new ConnectorError('aborted', '网页读取已停止');
        };
        try {
            check();
            try {
                await diagnostics.stage('dispatch', async () => context.beforeDispatch?.());
            } catch (error) {
                callbackFailure = { error };
                throw error;
            }
            check();
            const requestMain = async (previousFailure?: ConnectorError) => {
                try {
                    await diagnostics.stage('attempt', async () =>
                        context.beforeAttempt?.('read', previousFailure),
                    );
                } catch (error) {
                    callbackFailure = { error };
                    throw error;
                }
                check();
                const response = await diagnostics.stage('http', () =>
                    http.request(url, {
                        signal,
                        timeoutMs: Math.max(1, Math.ceil(deadlineAt - performance.now())),
                        onReadDiagnostic: diagnostics.relay,
                        maxBytes: PAGE_BYTES,
                        maxRedirects: 3,
                        responseEncoding: 'web-text',
                    }),
                );
                if (response.status < 200 || response.status >= 300)
                    throw new ConnectorError(
                        'http',
                        '网页采集失败',
                        response.status >= 500,
                        response.status,
                    );
                if (!htmlType(response.headers['content-type'] ?? ''))
                    throw new ConnectorError('invalid_response', '网页不是 HTML 正文');
                return response;
            };
            let main: HttpResponse;
            try {
                main = await requestMain();
            } catch (error) {
                if (
                    !(error instanceof ConnectorError) ||
                    !error.retryable ||
                    !(
                        error.code === 'network' ||
                        error.code === 'timeout' ||
                        (error.code === 'http' && (error.status ?? 0) >= 500)
                    )
                )
                    throw error;
                await delay(200, undefined, { signal });
                main = await requestMain(error);
            }
            check();
            // Follow redirects in the pinned Node transport, then navigate directly to the final URL.
            // No browser redirect may bypass routing or change the document after collection begins.
            const finalUrl = normalizeUrl(main.url);
            downloaded = Buffer.byteLength(main.body, 'utf8');
            if (downloaded > PAGE_BYTES)
                throw new ConnectorError('response_too_large', '网页超过下载限制');
            // Most article bodies are already in HTML. Do not execute unrelated site scripts
            // just to collect that evidence; the subprocess bounds synchronous DOM work.
            try {
                const html = await diagnostics.stage('extract', () =>
                    extractPageIsolated(
                        originalUrl,
                        main,
                        maxText,
                        BROWSER_EXTRACTION_VERSION,
                        true,
                        { signal, timeoutMs: 5000 },
                    ),
                );
                if (html.text.length >= 120 && html.collection?.complete === false)
                    staticPartial = html;
                if (
                    !html.collection?.limitations.includes('render_timeout') &&
                    (html.text.length >= 120 || !/<script\b/i.test(main.body))
                )
                    return {
                        ...html,
                        collection: {
                            version: 1,
                            method: 'html',
                            complete: !html.collection?.limitations.length,
                            limitations: html.collection?.limitations ?? [],
                        },
                    };
            } catch (error) {
                // Only an empty/loading shell needs rendering. Access restrictions, cancellation
                // and a CPU deadline must retain their identity, never trigger a second expensive parse.
                if (
                    !(error instanceof ConnectorError) ||
                    error.code !== 'extraction_failed' ||
                    isExtractionCapacityError(error)
                )
                    throw error;
            }
            check();
            if (staticPartial) {
                // Reserve cleanup time inside the caller's existing deadline.
                // An optional browser attempt must not discard verified partial HTML.
                const remaining = deadlineAt - performance.now() - 2000;
                if (remaining <= 0) return retainedPartial();
                renderTimer = setTimeout(() => renderBudget.abort(), remaining);
            }
            finishRender = diagnostics.begin('render');
            const { Configuration, Log, LogLevel, PlaywrightCrawler, RequestList } =
                await import('@crawlee/playwright');
            const { chromium } = await import('playwright');
            check();
            const config = new Configuration({
                persistStorage: false,
                purgeOnStart: false,
                logLevel: LogLevel.OFF,
            });
            const requestList = await RequestList.open(null, [{ url: finalUrl, noRetry: true }]);
            crawler = new PlaywrightCrawler(
                {
                    requestList,
                    maxRequestsPerCrawl: 1,
                    minConcurrency: 1,
                    maxConcurrency: 1,
                    maxRequestRetries: 0,
                    maxSessionRotations: 0,
                    useSessionPool: false,
                    retryOnBlocked: false,
                    navigationTimeoutSecs: 15,
                    requestHandlerTimeoutSecs: 15,
                    log: new Log({ level: LogLevel.OFF }),
                    launchContext: {
                        launcher: chromium,
                        useIncognitoPages: true,
                        launchOptions: {
                            headless: true,
                            timeout: 15_000,
                            chromiumSandbox: process.env.READER_CHROMIUM_SANDBOX !== 'false',
                            // Browser-side networking is a dead end. All allowed traffic is fulfilled by Node.
                            proxy: { server: 'http://127.0.0.1:9' },
                            args: [
                                '--disable-quic',
                                '--disable-background-networking',
                                '--disable-extensions',
                                '--host-resolver-rules=MAP * ~NOTFOUND',
                                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
                                ...(process.env.READER_CHROMIUM_SANDBOX === 'false'
                                    ? ['--no-sandbox']
                                    : []),
                            ],
                        },
                    },
                    browserPoolOptions: {
                        useFingerprints: false,
                        maxOpenPagesPerBrowser: 1,
                        prePageCreateHooks: [
                            (_id, _controller, pageOptions) => {
                                Object.assign(pageOptions ?? {}, {
                                    serviceWorkers: 'block',
                                    acceptDownloads: false,
                                });
                            },
                        ],
                    },
                    preNavigationHooks: [
                        async ({ page }, gotoOptions) => {
                            check();
                            browserContext = page.context();
                            gotoOptions.waitUntil = 'commit';
                            resourceTimer = setTimeout(
                                () => {
                                    if (inFlight.size) limitations.add('render_timeout');
                                    stopResources();
                                },
                                Math.max(4000, waitMs + 500),
                            );
                            await browserContext.routeWebSocket('**/*', (socket) => socket.close());
                            browserContext.on('page', (popup) => {
                                if (popup !== page) void popup.close().catch(() => undefined);
                            });
                            await browserContext.route('**/*', async (route) => {
                                const request = route.request();
                                const dispatch = (async () => {
                                    check();
                                    const isMain =
                                        request.isNavigationRequest() &&
                                        request.frame() === page.mainFrame();
                                    if (
                                        isMain &&
                                        (mainServed || normalizeUrl(request.url()) !== finalUrl)
                                    ) {
                                        fatal = new ConnectorError(
                                            'unsafe_url',
                                            '网页读取期间不允许二次导航',
                                        );
                                        await route.abort();
                                        return;
                                    }
                                    if (
                                        request.method() !== 'GET' ||
                                        ![
                                            'document',
                                            'script',
                                            'stylesheet',
                                            'xhr',
                                            'fetch',
                                        ].includes(request.resourceType()) ||
                                        (request.resourceType() === 'document' && !isMain)
                                    ) {
                                        await route.abort();
                                        return;
                                    }
                                    let response: HttpResponse;
                                    if (isMain) {
                                        mainServed = true;
                                        response = main;
                                    } else {
                                        if (!resourceOpen) {
                                            await route.abort();
                                            return;
                                        }
                                        if (++requests > MAX_REQUESTS) {
                                            limitations.add('resource_limit');
                                            stopResources();
                                            await route.abort();
                                            return;
                                        }
                                        // No cookies, Authorization or caller-controlled headers cross this bridge.
                                        const previousResource = resourceTail;
                                        const resource = (async () => {
                                            await previousResource;
                                            check();
                                            if (!resourceOpen)
                                                throw new ConnectorError(
                                                    'aborted',
                                                    '附属资源读取已结束',
                                                );
                                            const remaining = TOTAL_BYTES - downloaded;
                                            if (remaining < 1) {
                                                limitations.add('resource_limit');
                                                stopResources();
                                                throw new ConnectorError(
                                                    'response_too_large',
                                                    '网页资源总量超过限制',
                                                );
                                            }
                                            const fetched = await http.request(
                                                normalizeUrl(request.url()),
                                                {
                                                    signal: resourceSignal,
                                                    timeoutMs: 2000,
                                                    maxBytes: Math.min(PAGE_BYTES, remaining),
                                                    maxRedirects: 3,
                                                    responseEncoding: 'web-text',
                                                },
                                            );
                                            downloaded += Buffer.byteLength(fetched.body, 'utf8');
                                            if (fetched.status < 200 || fetched.status >= 300)
                                                throw new ConnectorError(
                                                    'http',
                                                    '附属资源读取失败',
                                                    false,
                                                    fetched.status,
                                                );
                                            return fetched;
                                        })();
                                        // Stop the resource budget before releasing queued work;
                                        // an optional-resource failure must not discard readable HTML.
                                        resourceTail = resource.catch((error: unknown) => {
                                            if (
                                                error instanceof ConnectorError &&
                                                error.code === 'response_too_large'
                                            ) {
                                                limitations.add('resource_limit');
                                                stopResources();
                                            }
                                        });
                                        response = await resource;
                                    }
                                    check();
                                    const headers = Object.fromEntries(
                                        Object.entries(response.headers).filter(
                                            ([name]) =>
                                                ![
                                                    'set-cookie',
                                                    'content-length',
                                                    'content-encoding',
                                                    'location',
                                                    'refresh',
                                                    'connection',
                                                    'transfer-encoding',
                                                ].includes(name.toLowerCase()),
                                        ),
                                    );
                                    await route.fulfill({
                                        status: response.status,
                                        headers,
                                        body: response.body,
                                    });
                                })();
                                inFlight.add(dispatch);
                                try {
                                    await dispatch;
                                } catch (error) {
                                    // Optional failures remain blocked. Only navigation/security
                                    // errors are terminal for the whole document.
                                    if (request.isNavigationRequest()) fatal ??= error;
                                    else if (resourceOpen) limitations.add('resource_failure');
                                    await route.abort().catch(() => undefined);
                                } finally {
                                    inFlight.delete(dispatch);
                                }
                            });
                        },
                    ],
                    requestHandler: async ({ page }) => {
                        check();
                        const started = performance.now();
                        const windowMs = Math.max(4000, waitMs + 500);
                        let previousText = '';
                        let stableSince = started;
                        let ready = false;
                        // Observe actual body readiness instead of waiting for every analytics
                        // script. Delayed client-rendered articles still get a bounded chance.
                        while (performance.now() - started < windowMs) {
                            check();
                            const body = await page.evaluate(pageSnapshot, false);
                            const loading = await page.evaluate(pageIsLoading, undefined);
                            const pendingData = await page.evaluate(pageHasPendingData, undefined);
                            if (body.text !== previousText) {
                                previousText = body.text;
                                stableSince = performance.now();
                            }
                            ready =
                                body.parsed &&
                                (body.text.length >= 120 || (body.article && !!body.text)) &&
                                !loading &&
                                !pendingData;
                            if (
                                ready &&
                                performance.now() - started >= waitMs &&
                                performance.now() - stableSince >= 250
                            )
                                break;
                            await delay(100, undefined, { signal });
                        }
                        if (!ready || inFlight.size) limitations.add('render_timeout');
                        stopResources();
                        clearTimeout(resourceTimer);
                        // Abort makes parser-blocking requests settle without extending the
                        // observation window. It never enables a direct browser network fallback.
                        await Promise.allSettled(inFlight);
                        check();
                        if (fatal) throw fatal;
                        const markup = (await page.evaluate(pageSnapshot, true)).markup!;
                        if (Buffer.byteLength(markup, 'utf8') > PAGE_BYTES)
                            throw new ConnectorError('response_too_large', '渲染后的网页超过限制');
                        const extracted = await extractPageIsolated(
                            originalUrl,
                            {
                                ...main,
                                url: finalUrl,
                                body: markup,
                                headers: { 'content-type': 'text/html; charset=utf-8' },
                            },
                            maxText,
                            BROWSER_EXTRACTION_VERSION,
                            true,
                            { signal, timeoutMs: 5000 },
                        );
                        for (const limitation of extracted.collection?.limitations ?? [])
                            limitations.add(limitation);
                        output = {
                            ...extracted,
                            collection: {
                                version: 1,
                                method: 'browser',
                                complete: limitations.size === 0,
                                limitations: [...limitations].sort(),
                            },
                        };
                    },
                    failedRequestHandler: (_ctx, error) => {
                        fatal ??= error;
                    },
                },
                config,
            );
            await crawler.run();
            check();
            if (fatal) throw fatal;
            if (!output) throw new ConnectorError('extraction_failed', '浏览器没有可提取正文');
            return output;
        } catch (error) {
            finishRender?.(error);
            if (callbackFailure && callbackFailure.error === error) throw error;
            const strongFailure =
                fatal instanceof ConnectorError &&
                !['aborted', 'extraction_failed'].includes(fatal.code);
            if (
                staticPartial &&
                !callerSignal.aborted &&
                !strongFailure &&
                !isExtractionCapacityError(error) &&
                (renderBudget.signal.aborted ||
                    (error instanceof ConnectorError &&
                        error.code === 'extraction_failed' &&
                        !isExtractionCapacityError(error))) &&
                (!(error instanceof ConnectorError) ||
                    ['aborted', 'extraction_failed'].includes(error.code))
            )
                return retainedPartial();
            if (error instanceof ConnectorError) throw error;
            throw new ConnectorError('extraction_failed', '网页渲染或正文提取失败');
        } finally {
            finishRender?.();
            const finishCleanup = diagnostics.begin('cleanup');
            clearTimeout(resourceTimer);
            clearTimeout(renderTimer);
            stopResources();
            signal.removeEventListener('abort', abort);
            await browserContext?.close().catch(() => undefined);
            await Promise.allSettled(inFlight);
            // run() performs teardown even on failure; also covers construction/pre-run aborts.
            await crawler?.teardown().catch(() => undefined);
            finishCleanup();
        }
    }

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
        },
    };
}
