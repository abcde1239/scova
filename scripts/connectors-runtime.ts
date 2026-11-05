import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
    createPageReader,
    createSafeHttpClient,
    createSearxngServiceClient,
    createSearxngSearch,
    nodeHttpTransport,
} from '../packages/connectors/src/index.ts';

// Deliberately exercise the privileged transport against a local fixture. The public
// client still rejects loopback; this is not a live-provider acceptance test.
const html =
    '<!doctype html><title>Runtime fixture</title><article><h1>Runtime fixture</h1><p>Original text from a local fixture, used to verify Readability on both supported runtimes.</p></article>';
let observedHost: string | undefined;
let notifySlow!: () => void;
const slowStarted = new Promise<void>((resolve) => {
    notifySlow = resolve;
});
const server = createServer((req, res) => {
    observedHost = req.headers.host;
    if (req.url === '/search') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                results: [
                    {
                        url: 'https://example.com/fixture',
                        title: 'Search fixture',
                        content: '<b>Local fixture snippet</b>',
                        engines: ['fixture'],
                    },
                ],
                unresponsive_engines: [],
            }),
        );
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/slow') {
        res.write('<article>');
        notifySlow();
    } else res.end(html);
});
const deadline = AbortSignal.timeout(5_000);
try {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const url = new URL(`http://scova-pin.invalid:${address.port}/fixture`);
    const options = {
        method: 'GET' as const,
        // Explicit Host must preserve the URL domain under IP pinning, even on Bun.
        headers: { Host: 'caller-override.invalid' },
        address: { address: '127.0.0.1', family: 4 },
        signal: deadline,
        maxBytes: 2_048,
    };
    const response = await nodeHttpTransport(url, options);
    assert.equal(observedHost, url.host);
    assert.equal(response.body, html);
    await assert.rejects(createSafeHttpClient().request('http://127.0.0.1/'), {
        code: 'unsafe_url',
    });
    const reader = createPageReader({
        http: {
            async request() {
                return { ...response, url: 'https://example.com/fixture' };
            },
        },
    });
    const page = await reader.read('https://example.com/fixture', { signal: deadline });
    assert(page.text.includes('Original text from a local fixture'));
    assert.equal(page.kind, 'read_page');
    const searchBaseUrl = `http://scova-search.invalid:${address.port}`;
    const search = await createSearxngSearch({
        baseUrl: searchBaseUrl,
        maxAttempts: 1,
        http: createSearxngServiceClient(searchBaseUrl, {
            resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        }),
    }).search('local fixture', { signal: deadline });
    assert.equal(search.provider, 'searxng');
    assert.equal(search.results[0].kind, 'search_snippet');
    assert.equal(search.results[0].snippet, 'Local fixture snippet');
    assert.equal(observedHost, new URL(searchBaseUrl).host);
    const abort = new AbortController();
    const pending = nodeHttpTransport(new URL('/slow', url), {
        ...options,
        signal: AbortSignal.any([abort.signal, deadline]),
    });
    const rejected = assert.rejects(pending, { code: 'aborted' });
    await slowStarted;
    abort.abort();
    await rejected;
    console.log(
        `PASS: ${process.versions.bun ? 'Bun' : 'Node'} local fixture DNS pin, Host, Readability, fixed SearxNG service, private-IP rejection and socket abort`,
    );
} finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
