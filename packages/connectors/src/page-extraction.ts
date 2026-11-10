import { createHash } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { normalizeUrl } from './http.ts';
import type { HttpResponse } from './http.ts';
import { ConnectorError, type ReadPage } from './types.ts';
import { extractPublication } from './dates.ts';
export const EXTRACTION_VERSION = 'readability-0.6.0/scova-text-v1';

export function pageFingerprint(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function extractPage(
    originalUrl: string,
    response: HttpResponse,
    maxText: number,
    extractionVersion = EXTRACTION_VERSION,
    normalizedEncoding = false,
): ReadPage {
    const contentType = response.headers['content-type'] ?? '';
    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(contentType))
        throw new ConnectorError('invalid_response', '网页不是 HTML 正文');
    const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
    if (charset && !/^utf-?8$/i.test(charset))
        throw new ConnectorError('invalid_response', '网页字符编码不支持');
    // Reader extracts text, not rendered styles. Modern source CSS can be valid
    // in browsers while unsupported by jsdom's CSS parser. Keep other diagnostics.
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => {
        if (Reflect.get(error, 'type') !== 'css parsing') console.error(error.message);
    });
    const dom = new JSDOM(response.body, { url: response.url, virtualConsole });
    try {
        const document = dom.window.document;
        if (document.getElementsByTagName('*').length > 20_000)
            throw new ConnectorError('extraction_failed', '网页节点数超过提取限制');
        const contentMeta = [...document.querySelectorAll('meta[http-equiv]')].find(
            (meta) => meta.getAttribute('http-equiv')?.toLowerCase() === 'content-type',
        );
        const declared =
            document.querySelector('meta[charset]')?.getAttribute('charset') ??
            contentMeta?.getAttribute('content')?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
        if (!normalizedEncoding && declared && !/^utf-?8$/i.test(declared))
            throw new ConnectorError('invalid_response', '网页声明的字符编码不支持');
        const publication = extractPublication(document);
        document
            .querySelectorAll('script,style,iframe,object,embed,form,noscript')
            .forEach((node) => node.remove());
        const article = new Readability(document, {
            charThreshold: 0,
            maxElemsToParse: 20_000,
        }).parse();
        const fullText = article?.textContent?.replace(/\s+/g, ' ').trim();
        if (!fullText) throw new ConnectorError('extraction_failed', '网页没有可提取正文');
        const text = fullText.slice(0, maxText);
        return {
            kind: 'read_page' as const,
            mode: 'live' as const,
            originalUrl,
            fetchedUrl: response.url,
            url: normalizeUrl(response.url),
            title: article?.title?.trim() ?? '',
            text,
            contentHash: pageFingerprint(text),
            extractionVersion,
            collectedAt: new Date().toISOString(),
            truncated: fullText.length > maxText,
            publication,
            untrusted: true as const,
        };
    } finally {
        dom.window.close();
    }
}
