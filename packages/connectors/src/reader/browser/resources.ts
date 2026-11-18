import { PAGE_BYTES, TOTAL_BYTES, MAX_REQUESTS } from './limits.ts';
import { normalizeUrl, type SafeHttpClient, type HttpResponse } from '../../http/index.ts';
import { ConnectorError, type PageCollection } from '../../types.ts';

export interface ResourceRouterOptions {
    page: import('playwright').Page;
    main: HttpResponse;
    finalUrl: string;
    http: SafeHttpClient;
    signal: AbortSignal;
    inFlight: Set<Promise<unknown>>;
    limitations: Set<PageCollection['limitations'][number]>;
    check: () => void;
    fail: (error: unknown, replace?: boolean) => void;
}

export function createResourceRouter({
    page,
    main,
    finalUrl,
    http,
    signal,
    inFlight,
    limitations,
    check,
    fail,
}: ResourceRouterOptions) {
    let downloaded = Buffer.byteLength(main.body, 'utf8');
    let requests = 1;
    let mainServed = false;
    let resourceTail: Promise<unknown> = Promise.resolve();
    const resources = new AbortController();
    const resourceSignal = AbortSignal.any([signal, resources.signal]);
    let resourceOpen = true;
    const stopResources = () => {
        resourceOpen = false;
        resources.abort();
    };
    return {
        stopResources,
        route: async (route: import('playwright').Route) => {
            const request = route.request();
            const dispatch = (async () => {
                check();
                const isMain =
                    request.isNavigationRequest() && request.frame() === page.mainFrame();
                if (isMain && (mainServed || normalizeUrl(request.url()) !== finalUrl)) {
                    fail(new ConnectorError('unsafe_url', '网页读取期间不允许二次导航'), true);
                    await route.abort();
                    return;
                }
                if (
                    request.method() !== 'GET' ||
                    !['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(
                        request.resourceType(),
                    ) ||
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
                            throw new ConnectorError('aborted', '附属资源读取已结束');
                        const remaining = TOTAL_BYTES - downloaded;
                        if (remaining < 1) {
                            limitations.add('resource_limit');
                            stopResources();
                            throw new ConnectorError('response_too_large', '网页资源总量超过限制');
                        }
                        const fetched = await http.request(normalizeUrl(request.url()), {
                            signal: resourceSignal,
                            timeoutMs: 2000,
                            maxBytes: Math.min(PAGE_BYTES, remaining),
                            maxRedirects: 3,
                            responseEncoding: 'web-text',
                        });
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
                if (request.isNavigationRequest()) fail(error);
                else if (resourceOpen) limitations.add('resource_failure');
                await route.abort().catch(() => undefined);
            } finally {
                inFlight.delete(dispatch);
            }
        },
    };
}
