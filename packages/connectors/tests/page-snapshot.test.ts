import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { JSDOM } from 'jsdom';
import { pageSnapshot } from '../src/reader/snapshot.ts';
import { pageIsLoading } from '../src/reader/extraction/readiness.ts';

const documents: JSDOM[] = [];
afterEach(() => {
    vi.unstubAllGlobals();
    for (const dom of documents.splice(0)) dom.window.close();
});
function fixture() {
    const dom = new JSDOM('<main id="root"></main>');
    documents.push(dom);
    vi.stubGlobal('document', dom.window.document);
    return dom.window.document;
}
describe('bounded read-only open shadow collection', () => {
    it('includes nested open roots without mutating the active DOM', () => {
        const document = fixture();
        const primary = document.querySelector('main')!;
        const first = primary.attachShadow({ mode: 'open' });
        first.innerHTML = '<section id="nested"></section>';
        const second = first.querySelector('section')!.attachShadow({ mode: 'open' });
        second.innerHTML = '<article><h1>Open component</h1><p>SHADOW-ARTICLE-END</p></article>';
        const original = document.documentElement.outerHTML;
        const snapshot = pageSnapshot(true);
        expect(snapshot.text).toContain('SHADOW-ARTICLE-END');
        expect(snapshot.article).toBe(true);
        expect(snapshot.markup).toContain('<p>SHADOW-ARTICLE-END</p>');
        expect(pageIsLoading(document, true)).toBe(false);
        expect(document.documentElement.outerHTML).toBe(original);
        expect(primary.childNodes).toHaveLength(0);
    });
    it('does not inspect a closed shadow root', () => {
        const document = fixture();
        document.querySelector('main')!.attachShadow({ mode: 'closed' }).innerHTML =
            '<article>PRIVATE-CLOSED-BODY</article>';
        expect(pageSnapshot(true).markup).not.toContain('PRIVATE-CLOSED-BODY');
        expect(pageSnapshot(false).text).not.toContain('PRIVATE-CLOSED-BODY');
    });
    it('rejects a deeply nested shadow tree at the same bounded depth', () => {
        const document = fixture();
        document.querySelector('main')!.attachShadow({ mode: 'open' }).innerHTML =
            '<div>'.repeat(65) + 'DEEP' + '</div>'.repeat(65);
        expect(() => pageSnapshot(true)).toThrow('超过提取限制');
        expect(() => pageIsLoading(document, true)).toThrow('超过提取限制');
    });
    it('accepts text and whitespace nodes within the existing element budget', () => {
        const document = fixture();
        document.querySelector('main')!.innerHTML =
            '<p>prefix <span>API reference</span> suffix</p>'.repeat(5000) + '<p>DOCUMENT-END</p>';
        expect(document.querySelectorAll('*').length).toBeLessThan(20_000);
        expect(pageIsLoading(document, true)).toBe(false);
        expect(pageSnapshot(true).text).toContain('DOCUMENT-END');
    });
    it('still bounds the number of elements independently of text nodes', () => {
        const document = fixture();
        document.querySelector('main')!.innerHTML = '<span>x</span>'.repeat(20_001);
        expect(() => pageSnapshot(true)).toThrow('超过提取限制');
        expect(() => pageIsLoading(document, true)).toThrow('超过提取限制');
    });
});
