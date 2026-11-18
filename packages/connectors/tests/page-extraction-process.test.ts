import { describe, expect, it } from 'vite-plus/test';
import { readFile } from 'node:fs/promises';
import { extractPageIsolated } from '../src/reader/extraction/process.ts';
import { pageFingerprint, extractPage } from '../src/reader/extraction/extract.ts';
import { validPageLinks } from '../src/reader/collection.ts';
import type { HttpResponse } from '../src/http/index.ts';
import { isExtractionCapacityError } from '../src/reader/extraction/capacity.ts';
import { ConnectorError } from '../src/types.ts';

const url = 'https://public.example/article';
const response: HttpResponse = {
    url,
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<article><p>正文完整保留，字符哈希必须对应实际采集的原文。</p></article>',
};

describe('isolated synchronous article extraction', () => {
    it('preserves bounded navigation targets separately from evidence text and rejects invalid metadata', () => {
        const page = extractPage(
            url,
            {
                ...response,
                body: '<nav><a href="/unrelated">Navigation</a></nav><main><p>Evidence.</p><a href="/release#date">Release</a><a href="/release">Duplicate</a><a href="javascript:alert(1)">Bad</a><a href="#local">Same page</a><a href="https://name:secret@example.com/">Credentials</a></main>',
            },
            10000,
        );
        expect(page.links).toEqual([{ url: 'https://public.example/release', text: 'Release' }]);
        expect(page.contentHash).toBe(pageFingerprint(page.text));
        expect(validPageLinks(page.links)).toBe(true);
        for (const invalid of [
            [{ url: 'javascript:alert(1)', text: 'Bad' }],
            [{ url: 'https://example.com/', text: '' }],
            Array.from({ length: 81 }, () => ({ url: 'https://example.com/', text: 'Too many' })),
        ])
            expect(validPageLinks(invalid)).toBe(false);
        expect(validPageLinks(undefined)).toBe(true);
    });
    it('keeps readiness capacity failures typed so browser retry cannot repeat them', async () => {
        const result = await extractPageIsolated(
            url,
            {
                ...response,
                body: '<main>' + '<div>'.repeat(66) + 'Too deep' + '</div>'.repeat(66) + '</main>',
            },
            1_000_000,
        ).catch((error) => error);
        expect(result).toMatchObject({
            code: 'extraction_failed',
            message: '网页节点数超过提取限制',
        });
        expect(isExtractionCapacityError(result)).toBe(true);
    });
    it('reads the complete real Python datetime reference including its final footnote', async () => {
        // Public Python documentation, captured 2026-11-10. Its license/footer are retained.
        // 10,474 elements but 22,261 total nodes: whitespace/text must not use the element quota.
        const body = await readFile(
            new URL('./fixtures/python-datetime.html', import.meta.url),
            'utf8',
        );
        const page = await extractPageIsolated(
            'https://docs.python.org/3/library/datetime.html',
            {
                ...response,
                url: 'https://docs.python.org/3/library/datetime.html',
                body,
            },
            1_000_000,
        );
        expect(page.text).toContain('datetime — Basic date and time types');
        expect(page.text).toContain('strptime');
        expect(page.text).toContain('guide to the mathematics of the ISO 8601 calendar');
        expect(page.text.length).toBeGreaterThan(90_000);
        expect(page.truncated).toBe(false);
        expect(page.contentHash).toBe(pageFingerprint(page.text));
    });
    it('returns actual text and metadata through the private Node host', async () => {
        const page = await extractPageIsolated(url, response, 1_000_000);
        expect(page.text).toBe('正文完整保留，字符哈希必须对应实际采集的原文。');
        expect(page.contentHash).toBe(pageFingerprint(page.text));
        expect(page.url).toBe(url);
        expect(page.untrusted).toBe(true);
    });
    it('preserves typed challenge errors across process boundaries', async () => {
        await expect(
            extractPageIsolated(url, { ...response, body: '<main>安全检测中</main>' }, 1_000_000),
        ).rejects.toMatchObject({ code: 'http', status: 403 });
    });
    it('preserves Unicode line separators in a long input and exact code text', async () => {
        const code = 'first\u2028second\u2029third';
        const page = await extractPageIsolated(
            url,
            {
                ...response,
                body: `<main><p>${'Controlled evidence. '.repeat(7000)}</p><pre>${code}</pre></main>`,
            },
            1_000_000,
        );
        expect(page.text).toContain(code);
        expect(page.contentHash).toBe(pageFingerprint(page.text));
    });
    it('honors a deadline, terminates the host and permits the next extraction', async () => {
        await expect(
            extractPageIsolated(url, response, 1_000_000, undefined, false, { timeoutMs: 1 }),
        ).rejects.toMatchObject({ code: 'timeout' });
        expect((await extractPageIsolated(url, response, 1_000_000)).text).toContain(
            '正文完整保留',
        );
    });
    it('cancels in-flight work and rejects pre-cancelled work', async () => {
        const controller = new AbortController();
        const result = extractPageIsolated(url, response, 1_000_000, undefined, false, {
            signal: controller.signal,
        });
        const settled = result.catch((error) => error);
        controller.abort();
        expect(await settled).toMatchObject({ code: 'aborted' });
        await expect(
            extractPageIsolated(url, response, 1_000_000, undefined, false, {
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ code: 'aborted' });
    });
});

describe('unrecoverable extraction capacity classification', () => {
    it.each(['网页节点数超过提取限制', '表格展开结构超过提取限制'])(
        'recognizes only an exact owned capacity failure: %s',
        (message) => {
            expect(
                isExtractionCapacityError(new ConnectorError('extraction_failed', message)),
            ).toBe(true);
        },
    );
    it.each([
        new ConnectorError('extraction_failed', '页面主正文仍在加载'),
        new ConnectorError('extraction_failed', 'article mentions 网页节点数超过提取限制'),
        new ConnectorError('network', '网页节点数超过提取限制'),
        new Error('网页节点数超过提取限制'),
    ])('does not broaden non-capacity failures: %s', (error) => {
        expect(isExtractionCapacityError(error)).toBe(false);
    });
});
