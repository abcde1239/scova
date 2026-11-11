import { describe, expect, it } from 'vite-plus/test';
import { extractPage, pageFingerprint } from '../src/page-extraction.ts';

const url = 'https://public.example/article';
const extract = (body: string, maxText = 1_000_000) =>
    extractPage(
        url,
        { url, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body },
        maxText,
    );

describe('article evidence quality and canonical text', () => {
    it.each([
        '<script>new TencentCaptcha("public",()=>{});</script>',
        '<main>安全检测中</main>',
        '<title>Just a moment...</title><main>Checking your browser</main>',
        '<title>Security verification</title><div id="cf-chl-widget">Please wait.</div>',
        '<title>登录</title><form><input type="password"><button>登录</button></form>',
        '<main>请登录后阅读</main>',
        '<title>Access denied</title><main>Access denied</main>',
    ])('rejects a challenge/access gate as unavailable public evidence: %s', (html) => {
        expect(() => extract(html)).toThrowError(
            expect.objectContaining({ code: 'http', status: 403 }),
        );
    });
    it.each([
        '加载中',
        '正在加载...',
        'Loading...',
        'Please wait…',
        '加载中，请稍候……',
        '正在加载文章，请稍后。',
        'Loading content, please wait...',
        'Please wait while we load the content.',
    ])('does not turn a loading shell into successful evidence: %s', (text) => {
        expect(() => extract(`<main>${text}</main>`)).toThrowError(
            expect.objectContaining({ code: 'extraction_failed' }),
        );
    });
    it('rejects a not-found error even when its HTTP status is 200', () => {
        expect(() =>
            extract('<title>Page not found</title><main>404 Not Found</main>'),
        ).toThrowError(expect.objectContaining({ code: 'http', status: 404 }));
    });
    it('retains a legitimate short notice', () => {
        const page = extract('<title>休馆通知</title><article>今日闭馆。</article>');
        expect(page.text).toBe('今日闭馆。');
        expect(page.truncated).toBe(false);
    });
    it('retains article text that discusses CAPTCHA and has a widget', () => {
        const paragraph = 'This article explains how CAPTCHA security widgets work. '.repeat(5);
        const page = extract(
            `<title>Security widgets explained</title><article><p>${paragraph}</p></article><script src="https://example.com/recaptcha.js">new TencentCaptcha();</script>`,
        );
        expect(page.text).toBe(paragraph.trim());
    });
    it('does not confuse an article about security verification with a gate', () => {
        const page = extract(
            '<title>Security verification methods explained</title><article><p>Security verification methods have practical benefits for public services.</p></article>',
        );
        expect(page.text).toContain('practical benefits');
    });
    it('rejects a loading heading followed by another loading message', () => {
        expect(() =>
            extract('<title>Loading</title><main><h1>Loading</h1><p>Please wait...</p></main>'),
        ).toThrowError(expect.objectContaining({ code: 'extraction_failed' }));
    });
    it('does not let long legal boilerplate certify a loading primary region', () => {
        const privacy =
            ' This website provides information for registered readers. Please check privacy policies and service conditions before continuing.'.repeat(
                5,
            );
        expect(() =>
            extract(
                `<title>Library notice</title><main id="root"><p>加载中，请稍候……</p><div>${privacy}</div></main><script src="/app.js"></script>`,
            ),
        ).toThrowError(expect.objectContaining({ code: 'extraction_failed' }));
    });
    it.each(['main', 'div id="root"', 'div id="app"'])(
        'does not certify an empty %s using a long footer',
        (opening) => {
            const tag = opening.split(' ')[0];
            expect(() =>
                extract(
                    `<${opening}></${tag}><footer>${'Privacy policies and service conditions. '.repeat(30)}</footer><script src="/app.js"></script>`,
                ),
            ).toThrowError(expect.objectContaining({ code: 'extraction_failed' }));
        },
    );
    it('keeps genuine prose that discusses loading and has a separate loading widget', () => {
        const page = extract(
            '<title>Loading states explained</title><main id="app"><p>加载中，请稍候……</p><article><p>This tutorial explains loading indicators and CAPTCHA challenges in a published article.</p><p>A loading indicator describes background work without replacing evidence.</p></article></main><script src="/comments.js"></script>',
        );
        expect(page.text).toContain('published article');
        expect(page.text).toContain('without replacing evidence');
    });
    it('keeps non-article prose when loading is only a later comments status', () => {
        const page = extract(
            '<main><p>The published notice confirms that the library opens at nine tomorrow morning.</p><p>Loading comments, please wait...</p></main>',
        );
        expect(page.text).toContain('opens at nine');
    });
    it('preserves canonical entities, malformed HTML, Unicode and exact retained-text hash', () => {
        const page = extract(
            '<title>Example</title><article><p>A&nbsp;B &amp; C <b>bold<p>中文 &#x1F600; &copy; 2026</article>',
        );
        expect(page.text).toContain('A B & C bold\n\n中文 😀 © 2026');
        expect(page.contentHash).toBe(pageFingerprint(page.text));
    });
    it('keeps a long article from first paragraph to tail without quadratic live DOM mutations', () => {
        const paragraphs = Array.from(
            { length: 4800 },
            (_, i) => `<div>第${i}段：完整保留文史正文，包括中间证据和末尾说明。</div>`,
        ).join('');
        const page = extract(
            `<title>长篇史料</title><main class="article-content">${paragraphs}</main>`,
        );
        expect(page.text).toContain('第0段');
        expect(page.text).toContain('第2400段');
        expect(page.text).toContain('第4799段');
        expect(page.text.length).toBeGreaterThan(100_000);
        expect(page.truncated).toBe(false);
        expect(page.contentHash).toBe(pageFingerprint(page.text));
    });
    it('does not leave half a UTF-16 surrogate when truncating', () => {
        const page = extract('<article><p>ABC😀末尾。</p></article>', 4);
        expect(page.text).toBe('ABC');
        expect(page.truncated).toBe(true);
    });
});
