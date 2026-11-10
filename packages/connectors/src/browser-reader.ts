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
import { extractPage } from './page-extraction.ts';
import { createDelegatedReader } from './browser-delegate.ts';
import { ConnectorError, type CallContext, type PageReader, type ReadPage } from './types.ts';

export const BROWSER_EXTRACTION_VERSION =
    'crawlee-3.18.2/playwright-1.64.1/readability-0.6.0/scova-text-v2';
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
    const maxText = positiveLimit(options.maxTextChars ?? 100_000, 200_000, '正文长度');
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
    ): Promise<ReadPage> {
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
                await context.beforeDispatch?.();
            } catch (error) {
                callbackFailure = { error };
                throw error;
            }
            check();
            const requestMain = async (previousFailure?: ConnectorError) => {
                try {
                    await context.beforeAttempt?.('read', previousFailure);
                } catch (error) {
                    callbackFailure = { error };
                    throw error;
                }
                check();
                const response = await http.request(url, {
                    signal,
                    maxBytes: PAGE_BYTES,
                    maxRedirects: 3,
                    responseEncoding: 'web-text',
                });
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
                            gotoOptions.waitUntil = 'domcontentloaded';
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
                                        if (++requests > MAX_REQUESTS) {
                                            fatal = new ConnectorError(
                                                'response_too_large',
                                                '网页资源请求超过限制',
                                            );
                                            await route.abort();
                                            return;
                                        }
                                        // No cookies, Authorization or caller-controlled headers cross this bridge.
                                        const previousResource = resourceTail;
                                        const resource = (async () => {
                                            await previousResource;
                                            check();
                                            if (fatal) throw fatal;
                                            const remaining = TOTAL_BYTES - downloaded;
                                            if (remaining < 1) {
                                                fatal = new ConnectorError(
                                                    'response_too_large',
                                                    '网页资源总量超过限制',
                                                );
                                                throw fatal;
                                            }
                                            const fetched = await http.request(
                                                normalizeUrl(request.url()),
                                                {
                                                    signal,
                                                    maxBytes: Math.min(PAGE_BYTES, remaining),
                                                    maxRedirects: 3,
                                                    responseEncoding: 'web-text',
                                                },
                                            );
                                            downloaded += Buffer.byteLength(fetched.body, 'utf8');
                                            return fetched;
                                        })();
                                        // Record terminal size failures before releasing the next
                                        // queued resource, including across the Bun/Node pipe.
                                        resourceTail = resource.catch((error: unknown) => {
                                            if (
                                                error instanceof ConnectorError &&
                                                error.code === 'response_too_large'
                                            )
                                                fatal ??= error;
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
                                    // Forbidden/failed optional resources remain blocked, never fetched directly by Chrome.
                                    if (
                                        request.isNavigationRequest() ||
                                        (error instanceof ConnectorError &&
                                            error.code === 'response_too_large')
                                    )
                                        fatal ??= error;
                                    await route.abort().catch(() => undefined);
                                } finally {
                                    inFlight.delete(dispatch);
                                }
                            });
                        },
                    ],
                    requestHandler: async ({ page }) => {
                        check();
                        await delay(waitMs, undefined, { signal });
                        if (inFlight.size) await Promise.allSettled(inFlight);
                        check();
                        if (fatal) throw fatal;
                        const markup = await page.content();
                        if (Buffer.byteLength(markup, 'utf8') > PAGE_BYTES)
                            throw new ConnectorError('response_too_large', '渲染后的网页超过限制');
                        output = extractPage(
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
                        );
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
            if (callbackFailure && callbackFailure.error === error) throw error;
            if (error instanceof ConnectorError) throw error;
            throw new ConnectorError(
                'extraction_failed',
                '浏览器读取失败，请检查 Chromium 安装和运行环境',
            );
        } finally {
            signal.removeEventListener('abort', abort);
            await browserContext?.close().catch(() => undefined);
            await Promise.allSettled(inFlight);
            // run() performs teardown even on failure; also covers construction/pre-run aborts.
            await crawler?.teardown().catch(() => undefined);
        }
    }

    return {
        read(originalUrl, context = {}) {
            if (closed) return Promise.reject(new ConnectorError('aborted', '网页读取器已关闭'));
            const url = normalizeUrl(originalUrl);
            const controller = new AbortController();
            controllers.add(controller);
            const previous = tail;
            const result = withDeadline(
                Math.min(context.timeoutMs ?? 15_000, 15_000),
                context.signal
                    ? AbortSignal.any([context.signal, controller.signal])
                    : controller.signal,
                (signal) => {
                    const task = (async () => {
                        await previous;
                        return render(originalUrl, url, context, signal);
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
