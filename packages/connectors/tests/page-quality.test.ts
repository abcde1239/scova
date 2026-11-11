import { describe, expect, it } from 'vite-plus/test';
import { JSDOM } from 'jsdom';
import { checkPageQuality } from '../src/page-quality.ts';
import { pageIsLoading } from '../src/page-readiness.ts';

function quality(markup: string) {
    const dom = new JSDOM(markup);
    try {
        return checkPageQuality(dom.window.document, markup);
    } finally {
        dom.window.close();
    }
}
const prose =
    'The library publishes its winter opening dates and explains eligibility, fees and application conditions for readers. '.repeat(
        5,
    );

describe('primary content readiness and access scope', () => {
    it.each([
        `<main aria-busy="true"><article><p>${prose}</p></article></main><script src="/app.js"></script>`,
        `<main></main><section class="related"><article>${prose}</article></section><script src="/app.js"></script>`,
        `<main><div>加载中，请稍候……</div><p>${prose}</p></main><script src="/app.js"></script>`,
        `<main><span>Loading content, please wait...</span><div>${prose}</div></main><script src="/app.js"></script>`,
    ])('does not certify a primary loading region using preview or unrelated content', (markup) => {
        expect(() => quality(markup)).toThrowError(
            expect.objectContaining({ code: 'extraction_failed' }),
        );
    });
    it('allows a completed article with an independently loading comment widget', () => {
        expect(
            quality(
                `<main><article><p>${prose}</p></article><div aria-busy="true" role="status">Loading comments...</div></main><script></script>`,
            ),
        ).toEqual([]);
    });
    it('allows a published notice when loading status only occurs later', () => {
        expect(quality(`<main><p>${prose}</p><span>Loading...</span></main>`)).toEqual([]);
    });
    it.each([
        `<title>用户登录</title><main><form><input type="password"></form><p>${prose}</p></main>`,
        `<title>用户登录</title><main><form><input type="password"></form><article><h1>服务条款</h1><p>${prose}</p></article></main>`,
        `<title>Just a moment...</title><main><p>${prose}</p></main>`,
        `<main><section class="paywall"><h2>订阅后阅读全文</h2><p>${prose}</p></section></main>`,
    ])('does not let long gate explanations count as public body', (markup) => {
        expect(() => quality(markup)).toThrowError(
            expect.objectContaining({ code: 'http', status: 403 }),
        );
    });
    it('rejects an HTTP 200 not-found page despite long legal footer', () => {
        expect(() =>
            quality(
                `<title>404 Not Found</title><main>Page not found.</main><footer>${prose}</footer>`,
            ),
        ).toThrowError(expect.objectContaining({ code: 'http', status: 404 }));
    });
    it('keeps a public abstract while recording subscription restrictions', () => {
        expect(
            quality(
                `<main><section data-title="Abstract"><p>${prose}</p></section><p>This is a preview of subscription content, access via your institution.</p></main>`,
            ),
        ).toEqual(['content_restricted']);
    });
    it('does not treat an article discussing subscription gates as a gate', () => {
        expect(
            quality(
                `<title>Paywall design patterns</title><main><article><p>${prose}</p><p>Sites use the phrase subscribe to read when describing their pricing.</p></article></main>`,
            ),
        ).toEqual([]);
    });
    it('keeps a public article with an optional sidebar login form', () => {
        expect(
            quality(
                `<title>公开通知</title><main><article><p>${prose}</p></article><aside><form><input type="password"></form></aside></main>`,
            ),
        ).toEqual([]);
    });
    it('does not certify an unfinished primary data chart using source/license text', () => {
        expect(
            quality(
                `<main><h1>Population, total</h1><p>${prose}</p><div class="d3-chart spinning"></div><p>License: CC BY 4.0</p></main><script src="/charts.js"></script>`,
            ),
        ).toEqual(['render_timeout']);
    });
    it('does not treat a spinning sidebar chart as unfinished primary article content', () => {
        expect(
            quality(
                `<main><article><p>${prose}</p></article><aside><div class="d3-chart spinning"></div></aside></main>`,
            ),
        ).toEqual([]);
    });
    it('records SVG text when graph edges have semantics unavailable in plain text', () => {
        expect(
            quality(
                '<main><h1>SQL syntax</h1><svg><path d="M0 0 L10 10"></path><text>SELECT</text><text>FROM</text></svg></main>',
            ),
        ).toEqual(['visual_structure']);
    });
    it('does not mark a navigation logo or a text-only decorative SVG as missing structure', () => {
        expect(
            quality(
                `<header><svg><path d="M0 0"></path><text>Logo</text></svg></header><main><p>${prose}</p><svg><text>Decoration</text></svg></main>`,
            ),
        ).toEqual([]);
    });
    it('rejects a refresh shell without public article content', () => {
        expect(() =>
            quality(
                '<meta http-equiv="refresh" content="0; url=/new"><p>Redirecting to the new article...</p>',
            ),
        ).toThrowError(expect.objectContaining({ code: 'invalid_response' }));
    });
    it('keeps a short valid notice without a length minimum', () => {
        expect(quality('<title>休馆通知</title><main>今日闭馆。</main>')).toEqual([]);
    });
    it('records an explicit next page without claiming its unseen content', () => {
        expect(
            quality(
                `<main><article>${prose}</article><a rel="next" href="/page-2">下一页</a></main>`,
            ),
        ).toEqual(['interaction_required']);
    });
    it('does not mistake a standard collapsed details element for unavailable body', () => {
        expect(
            quality(
                `<main><article>${prose}<details><summary>展开全文</summary><p>All public information is already in this HTML.</p></details></article></main>`,
            ),
        ).toEqual([]);
    });
    it('does not treat an independent next chapter as missing article content', () => {
        expect(
            quality(
                `<link rel="next" href="/chapter-2"><main><article>${prose}</article><nav><a rel="next" href="/chapter-2">6. Modules</a></nav></main>`,
            ),
        ).toEqual([]);
    });
    it('uses the same main-region readiness function in a browser-compatible call', () => {
        const dom = new JSDOM(`<main aria-busy="true"><article>${prose}</article></main>`);
        try {
            expect(pageIsLoading(dom.window.document, true)).toBe(true);
            dom.window.document.querySelector('main')!.removeAttribute('aria-busy');
            expect(pageIsLoading(dom.window.document, true)).toBe(false);
        } finally {
            dom.window.close();
        }
    });
});
