import { describe, expect, it } from 'vite-plus/test';
import { JSDOM } from 'jsdom';
import { extractPage, pageFingerprint } from '../src/page-extraction.ts';
import { compactRubyMarkup } from '../src/page-ruby-compaction.ts';

const url = 'https://public.example/novel';
const ruby = '<ruby><rb>私</rb><rp>（</rp><rt>わたくし</rt><rp>）</rp></ruby>';
function extract(body: string) {
    return extractPage(
        url,
        {
            url,
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body,
        },
        1_000_000,
    );
}

describe('lossless bounded ruby wrapper normalization', () => {
    it('preserves a complete ruby-heavy novel without raising the retained structural limit', () => {
        const paragraph = (marker: string) =>
            `<p>${marker} ${ruby.repeat(1400)} &amp; &lt;終&gt; &#x1F600;</p>`;
        const page = extract(
            `<title>注音長文</title><script type="application/ld+json">{"@type":"Article","url":"${url}","datePublished":"2026-11-10T00:00:00Z"}</script><div class="main_text">${paragraph('START')}${paragraph('MIDDLE')}${paragraph('END')}<pre>first\n    second\n# comment\nlast</pre></div>`,
        );
        expect(page.title).toBe('注音長文');
        expect(page.text).toBe(
            ['START', 'MIDDLE', 'END']
                .map((marker) => `${marker} ${'私（わたくし）'.repeat(1400)} & <終> 😀`)
                .join('\n\n') + '\n\nfirst\n    second\n# comment\nlast',
        );
        expect(page.contentHash).toBe(pageFingerprint(page.text));
        expect(page.publication?.instant).toBe('2026-11-10T00:00:00.000Z');
        expect(page.truncated).toBe(false);
    });
    it('does not flatten hidden or complex ruby into visible prose', () => {
        const page = extract(
            `<main>${ruby.repeat(4100)}<ruby hidden><rb>HIDDEN-BASE</rb><rt>HIDDEN-READING</rt></ruby><ruby><a href="https://example.org">LINKED-BASE</a><rt>LINKED-READING</rt></ruby><p>TAIL</p></main>`,
        );
        expect(page.text).not.toContain('HIDDEN-');
        expect(page.text).toContain('LINKED-BASELINKED-READING');
        expect(page.text).toContain('TAIL');
    });
    it('still rejects an oversized non-ruby structure', () => {
        expect(() => extract(`<main>${'<i>text</i>'.repeat(20001)}</main>`)).toThrowError(
            expect.objectContaining({
                code: 'extraction_failed',
                message: '网页节点数超过提取限制',
            }),
        );
    });
    it('keeps a strict source-element budget even when ruby could collapse it', () => {
        const dom = new JSDOM(`<main>${ruby.repeat(10001)}</main>`);
        try {
            expect(() => compactRubyMarkup(dom.window.document)).toThrowError(
                expect.objectContaining({
                    code: 'extraction_failed',
                    message: '网页节点数超过提取限制',
                }),
            );
        } finally {
            dom.window.close();
        }
    });
    it('rejects a deeply nested normalization candidate', () => {
        const dom = new JSDOM(
            `<main>${ruby}${'<div>'.repeat(65)}tail${'</div>'.repeat(65)}</main>`,
        );
        try {
            expect(() => compactRubyMarkup(dom.window.document)).toThrow('网页节点数超过提取限制');
        } finally {
            dom.window.close();
        }
    });
});
