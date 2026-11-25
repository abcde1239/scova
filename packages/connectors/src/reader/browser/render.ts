import { PAGE_BYTES } from './limits.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlaywrightCrawler } from '@crawlee/playwright';
import type { BrowserContext } from 'playwright';
import { normalizeUrl, type SafeHttpClient } from '../../http/index.ts';
import type { extractPageIsolated } from '../extraction/process.ts';
import { isExtractionCapacityError } from '../extraction/capacity.ts';
import { pageIsLoading } from '../extraction/readiness.ts';
import { pageHasPendingData } from '../extraction/data-readiness.ts';
import { pageSnapshot } from '../snapshot.ts';
import { readDiagnostics } from '../diagnostics.ts';
import {
    ConnectorError,
    type CallContext,
    type ReadPage,
    type PageCollection,
} from '../../types.ts';
import { BROWSER_EXTRACTION_VERSION } from './version.ts';
import { createResourceRouter } from './resources.ts';
import { requestMainDocument } from './request.ts';

export function createPageRenderer(
    http: SafeHttpClient,
    maxText: number,
    waitMs: number,
    extract: typeof extractPageIsolated,
) {
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
        const inFlight = new Set<Promise<unknown>>();
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
        let resourceRouter: ReturnType<typeof createResourceRouter> | undefined;
        const stopResources = () => resourceRouter?.stopResources();
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
            const main = await requestMainDocument(
                url,
                http,
                context,
                signal,
                deadlineAt,
                diagnostics,
                check,
                (error) => {
                    callbackFailure = { error };
                },
            );
            check();
            // Follow redirects in the pinned Node transport, then navigate directly to the final URL.
            // No browser redirect may bypass routing or change the document after collection begins.
            const finalUrl = normalizeUrl(main.url);
            if (Buffer.byteLength(main.body, 'utf8') > PAGE_BYTES)
                throw new ConnectorError('response_too_large', '网页超过下载限制');
            // Most article bodies are already in HTML. Do not execute unrelated site scripts
            // just to collect that evidence; the subprocess bounds synchronous DOM work.
            try {
                const html = await diagnostics.stage('extract', () =>
                    extract(originalUrl, main, maxText, BROWSER_EXTRACTION_VERSION, true, {
                        signal,
                        timeoutMs: 5000,
                    }),
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
                            resourceRouter = createResourceRouter({
                                page,
                                main,
                                finalUrl,
                                http,
                                signal,
                                inFlight,
                                limitations,
                                check,
                                fail: (error, replace) => {
                                    if (replace) fatal = error;
                                    else fatal ??= error;
                                },
                            });
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
                            await browserContext.route('**/*', resourceRouter!.route);
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
                        const extracted = await extract(
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

    return render;
}
