import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vite-plus/test';
import { extractPublication, describePublication, assessPublication } from '../src/index.ts';

function read(head = '', article = '') {
    const dom = new JSDOM(
        `<html><head><title>测试文章</title>${head}</head><body><article><h1>测试文章</h1>${article}</article></body></html>`,
        { url: 'https://example.com/article?utm_source=search' },
    );
    try {
        return extractPublication(dom.window.document);
    } finally {
        dom.window.close();
    }
}
const dates = (head = '', body = '') => describePublication(read(head, body));
describe('source publication precision and independent modification', () => {
    it('extracts common meta fields and preserves day precision instead of inventing UTC midnight', () => {
        const metadata = read(
            '<meta name="publishdate" content="2026年11月08日"><meta property="article:modified_time" content="2026-11-09T09:30+0800">',
        );
        expect(describePublication(metadata)).toMatchObject({
            published: { status: 'known', value: '2026-11-08', instant: null, precision: 'day' },
            modified: { instant: '2026-11-09T01:30:00.000Z', precision: 'instant' },
        });
        expect(assessPublication(metadata, '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z')).toBe(
            'in_window',
        );
        expect(assessPublication(metadata, '2026-11-08T00:00:00Z', '2026-11-08T23:59:59Z')).toBe(
            'unknown',
        );
        expect(assessPublication(metadata, '2026-11-10T00:00:00Z', '2026-11-11T00:00:00Z')).toBe(
            'outside',
        );
    });
    it('keeps local clocks without assuming the task or server timezone', () => {
        expect(
            dates('<meta name="datePublished" content="2026-11-08 10:30">').published,
        ).toMatchObject({
            status: 'known',
            value: '2026-11-08T10:30:00',
            precision: 'local',
            instant: null,
        });
    });
    it('accepts explicit publication in the sole article header while excluding recommendation and deadline dates', () => {
        const data = dates(
            '',
            '<header><time itemprop="datePublished" datetime="2026-11-08T10:30Z">Published</time></header><time datetime="2027-01-01">申请截止</time><aside><time pubdate datetime="2025-01-01">推荐</time></aside>',
        );
        expect(data.published.instant).toBe('2026-11-08T10:30:00.000Z');
    });
    it('accepts canonical identity with tracking removed and title-bound root JSON-LD', () => {
        for (const identity of [{ url: 'https://example.com/article' }, { headline: '测试文章' }]) {
            expect(
                dates(
                    `<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', ...identity, datePublished: '2026-11-08', dateModified: '2026-11-09' })}</script>`,
                ),
            ).toMatchObject({
                published: { value: '2026-11-08' },
                modified: { value: '2026-11-09' },
            });
        }
    });
    it('keeps valid publication when unrelated JSON is malformed or a duplicate date is lower precision', () => {
        expect(
            dates(
                '<meta property="article:published_time" content="2026-11-08T10:00:00Z"><meta name="publishdate" content="2026-11-08"><script type="application/ld+json">bad json</script>',
            ).published.instant,
        ).toBe('2026-11-08T10:00:00.000Z');
    });
    it('retains conflicting publication dates, never substitutes an update or a deadline', () => {
        expect(
            dates(
                '<meta name="publishdate" content="2026-11-01"><meta itemprop="datePublished" content="2026-11-08">',
            ).published.status,
        ).toBe('conflict');
        expect(
            dates(
                '<meta property="article:modified_time" content="2026-11-09">',
                '<time datetime="2026-11-08">申请截止</time>',
            ),
        ).toMatchObject({ published: { status: 'unknown' }, modified: { value: '2026-11-09' } });
    });
    it.each([
        '2026-02-30',
        '2026-13-01',
        '2026-11-08T10:00:00-00:00',
        '2026-11-08T10:00:00+14:01',
        'yesterday',
    ])('rejects invalid or ambiguous date %s', (raw) => {
        expect(dates(`<meta name="publishdate" content="${raw}">`).published.status).toBe(
            'unknown',
        );
    });
});
