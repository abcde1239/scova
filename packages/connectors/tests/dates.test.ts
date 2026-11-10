import { describe, expect, it } from 'vite-plus/test';
import {
    assessPublication,
    createHttpPageReader as createPageReader,
    createSafeHttpClient,
    validatePublication,
    type HttpTransport,
    type ReadPublication,
} from '../src/index.ts';

const knownDate = '2026-10-25T12:00:00.000Z';
const publication = (values: string[]): ReadPublication => ({
    parserVersion: 'scova-publication-v1',
    status: 'known',
    instant: '2000-01-01T00:00:00Z',
    observations: values.map((rawValue) => ({
        field: 'datePublished',
        rawValue,
        locator: 'jsonld[0]$.datePublished',
    })),
});
const paragraph =
    'This article explains the application process, eligibility and supporting documents with verifiable source information. '.repeat(
        12,
    );
async function readHtml(
    metadata: string,
    bodyMetadata = '',
    articleIdentity = 'itemid="https://public.example/article"',
) {
    let calls = 0;
    const transport: HttpTransport = async () => {
        calls++;
        return {
            status: 200,
            headers: { 'content-type': 'text/html', date: knownDate },
            body: `<html><head><title>Publication metadata</title>${metadata}</head><body><nav><time datetime="2000-01-01T00:00:00Z">navigation date</time></nav><article ${articleIdentity}><h1>Publication metadata</h1>${bodyMetadata}<p>${paragraph}</p><p>${paragraph}</p></article><script>globalThis.__scovaPublicationExecuted=true;fetch('http://127.0.0.1/secret')</script></body></html>`,
        };
    };
    const http = createSafeHttpClient({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport,
    });
    const page = await createPageReader({ http }).read('https://public.example/article');
    expect(calls).toBe(1);
    expect(Reflect.get(globalThis, '__scovaPublicationExecuted')).toBeUndefined();
    return page;
}

describe('publication metadata trust and interval assessment', () => {
    it('recomputes known time from observations and ignores asserted status and instant', () => {
        expect(validatePublication(publication([knownDate]))).toEqual({
            status: 'known',
            instant: knownDate,
        });
        expect(
            validatePublication({ ...publication([]), status: 'known', instant: knownDate }),
        ).toEqual({ status: 'unknown', instant: null });
        expect(
            validatePublication({ ...publication([knownDate]), status: 'conflict', instant: null }),
        ).toEqual({ status: 'known', instant: knownDate });
    });
    it('normalizes timezone offsets and detects independent conflicting dates', () => {
        expect(validatePublication(publication([knownDate, '2026-10-25T21:00:00+09:00']))).toEqual({
            status: 'known',
            instant: knownDate,
        });
        expect(validatePublication(publication([knownDate, '2026-10-26T12:00:00Z']))).toEqual({
            status: 'conflict',
            instant: null,
        });
    });
    it.each([
        '2026-10-25',
        '2026-10-25T12:00:00',
        'yesterday',
        '2026-02-30T12:00:00Z',
        '2026-13-01T12:00:00Z',
        '2026-10-25T12:00:00+14:01',
        '2026-10-25T24:00:00Z',
        '2026-10-25T12:00:00-00:00',
    ])('does not guess invalid or ambiguous date %s', (raw) => {
        expect(validatePublication(publication([raw])).status).toBe('unknown');
    });
    it('retains uncertainty when valid metadata coexists with ambiguous metadata', () => {
        expect(validatePublication(publication([knownDate, '2026-10-25'])).status).toBe('unknown');
    });
    it.each([
        undefined,
        null,
        {},
        { ...publication([knownDate]), parserVersion: 'future-parser' },
        { ...publication([knownDate]), status: 'forged' },
        {
            parserVersion: 'scova-publication-v1',
            observations: publication([knownDate]).observations,
        },
        publication(Array.from({ length: 33 }, () => knownDate)),
        publication(['x'.repeat(257)]),
        {
            ...publication([]),
            observations: [{ field: 'dateModified', rawValue: knownDate, locator: 'script' }],
        },
        {
            ...publication([]),
            observations: [{ field: 'datePublished', rawValue: knownDate, locator: '' }],
        },
    ])('rejects malformed or oversized observation metadata %#', (value) => {
        expect(validatePublication(value)).toEqual({ status: 'unknown', instant: null });
    });
    it('assesses an inclusive interval without substituting collection time', () => {
        expect(assessPublication(publication([knownDate]), knownDate, knownDate)).toBe('in_window');
        expect(
            assessPublication(
                publication([knownDate]),
                '2026-10-26T00:00:00Z',
                '2026-10-27T00:00:00Z',
            ),
        ).toBe('outside');
        expect(assessPublication(publication([knownDate]), new Date('invalid'), new Date())).toBe(
            'unknown',
        );
        expect(assessPublication(publication([knownDate]), '2026-10-25', knownDate)).toBe(
            'unknown',
        );
        expect(assessPublication(publication([]), knownDate, knownDate)).toBe('unknown');
        expect(
            assessPublication(
                publication([knownDate, '2026-10-26T12:00:00Z']),
                knownDate,
                knownDate,
            ),
        ).toBe('conflict');
    });
});

describe('HTML reader publication extraction', () => {
    it('extracts article meta and Article JSON-LD before scripts are removed, without changing body hash', async () => {
        const baseline = await readHtml('');
        const page = await readHtml(
            `<meta property="article:published_time" content="${knownDate}"><script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'NewsArticle', url: 'https://public.example/article#story', datePublished: '2026-10-25T21:00:00+09:00', dateModified: '2026-10-26T00:00:00Z' }] })}</script>`,
        );
        expect(page.publication).toMatchObject({ status: 'known', instant: knownDate });
        expect(page.publication?.observations.map((entry) => entry.field)).toEqual([
            'article:published_time',
            'datePublished',
            'dateModified',
        ]);
        expect(page.text).toBe(baseline.text);
        expect(page.contentHash).toBe(baseline.contentHash);
    });
    it('extracts a publication time inside article and keeps modification separate from publication', async () => {
        const page = await readHtml(
            '',
            `<time itemprop="datePublished" datetime="${knownDate}">Published</time><time itemprop="dateModified" datetime="2026-10-26T00:00:00Z">Updated</time>`,
        );
        expect(page.publication).toMatchObject({
            status: 'known',
            instant: knownDate,
            observations: [
                { field: 'time[datetime]', rawValue: knownDate },
                { field: 'time:modified', rawValue: '2026-10-26T00:00:00Z' },
            ],
        });
    });
    it.each([
        { url: 'https://public.example/article#article' },
        { url: { '@id': 'https://public.example/article' } },
        { '@id': '#article' },
        { mainEntityOfPage: 'https://public.example/article' },
        { mainEntityOfPage: { '@id': 'https://public.example/article#webpage' } },
    ])('binds JSON-LD publication to the fetched document identity %#', async (identity) => {
        const page = await readHtml(
            `<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', ...identity, datePublished: knownDate })}</script>`,
        );
        expect(page.publication).toMatchObject({ status: 'known', instant: knownDate });
    });
    it.each([
        {
            '@type': 'ItemList',
            itemListElement: [
                {
                    '@type': 'Article',
                    url: 'https://other.example/recommended',
                    datePublished: knownDate,
                },
            ],
        },
        { '@type': 'Article', datePublished: knownDate },
        {
            '@type': 'ItemList',
            itemListElement: [{ '@type': 'Article', datePublished: knownDate }],
        },
        {
            '@type': 'Article',
            url: 'https://other.example/recommended',
            mainEntityOfPage: 'https://public.example/article',
            datePublished: knownDate,
        },
    ])(
        'does not assign an unrelated or unidentified Article date to the main document %#',
        async (jsonld) => {
            const page = await readHtml(
                `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`,
            );
            expect(page.publication).toMatchObject({
                status: 'unknown',
                instant: null,
                observations: [],
            });
        },
    );
    it('ignores nested related article publication even with a current-document identity', async () => {
        const page = await readHtml(
            '',
            `<article itemid="https://public.example/article"><time itemprop="datePublished" datetime="${knownDate}">Recommended story</time><p>${paragraph}</p></article>`,
        );
        expect(page.publication).toMatchObject({
            status: 'unknown',
            instant: null,
            observations: [],
        });
    });
    it('keeps head publication metadata independent of dates on related articles', async () => {
        const unrelated = {
            '@type': 'ItemList',
            itemListElement: [
                {
                    '@type': 'Article',
                    url: 'https://other.example/story',
                    datePublished: '2026-11-01T00:00:00Z',
                },
            ],
        };
        const page = await readHtml(
            `<meta property="article:published_time" content="${knownDate}"><script type="application/ld+json">${JSON.stringify(unrelated)}</script>`,
            '<article><meta property="article:published_time" content="2026-11-01T00:00:00Z"></article>',
        );
        expect(page.publication).toMatchObject({ status: 'known', instant: knownDate });
        expect(page.publication?.observations).toHaveLength(1);
    });
    it.each(['', 'itemid="https://other.example/recommended"'])(
        'accepts the sole article but rejects an explicitly mismatched article identity %#',
        async (identity) => {
            const page = await readHtml(
                '',
                `<time itemprop="datePublished" datetime="${knownDate}">Published</time>`,
                identity,
            );
            expect(page.publication).toMatchObject({
                status: identity ? 'unknown' : 'known',
                instant: identity ? null : knownDate,
            });
            if (identity) expect(page.publication?.observations).toEqual([]);
        },
    );
    it.each([
        '',
        `<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', dateModified: knownDate })}</script>`,
        `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', datePublished: knownDate })}</script>`,
    ])('keeps missing, ambiguous or non-publication metadata unknown %#', async (metadata) => {
        expect((await readHtml(metadata)).publication).toMatchObject({
            status: 'unknown',
            instant: null,
        });
    });
    it('preserves conflicts rather than choosing the first source', async () => {
        const page = await readHtml(
            `<meta property="article:published_time" content="${knownDate}">`,
            `<time pubdate datetime="2026-10-26T00:00:00Z">Conflicting date</time>`,
        );
        expect(page.publication).toMatchObject({ status: 'conflict', instant: null });
    });
    it('does not mistake an event or application deadline for publication time', async () => {
        const deadline = '<time datetime="2026-11-15T12:00:00Z">Application deadline</time>';
        expect((await readHtml('', deadline)).publication).toMatchObject({
            status: 'unknown',
            instant: null,
            observations: [],
        });
        const page = await readHtml(
            `<meta property="article:published_time" content="${knownDate}">`,
            deadline,
        );
        expect(page.publication).toMatchObject({ status: 'known', instant: knownDate });
        expect(page.publication?.observations).toHaveLength(1);
    });
    it.each([
        `<meta property="article:published_time" content="${knownDate}"><script type="application/ld+json">{"@type":"Article","datePublished":"${'x'.repeat(262_144)}"}</script>`,
        `<meta property="article:published_time" content="${knownDate}">${`<meta property="article:published_time" content="${knownDate}">`.repeat(33)}`,
    ])(
        'treats overflow or malformed JSON-LD conservatively without side effects %#',
        async (metadata) => {
            const page = await readHtml(metadata);
            expect(page.publication).toMatchObject({ status: 'unknown', instant: null });
            expect(page.text).toContain('application process');
        },
    );
});
