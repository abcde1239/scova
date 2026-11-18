import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { normalizeUrl } from '../../http/index.ts';
import type { HttpResponse } from '../../http/index.ts';
import { ConnectorError, type ReadPage } from '../../types.ts';
import { extractPublication } from '../dates.ts';
import { checkPageQuality } from './quality.ts';
import {
    primaryPageText,
    getPageTitle,
    preparePageFallback,
    selectPageContent,
} from './content.ts';
import { serializePageText } from './text.ts';
import { EXTRACTION_VERSION } from './version.ts';
import { compactRubyMarkup } from './ruby-compaction.ts';
export { EXTRACTION_VERSION } from './version.ts';

// This optional CJS entry has no upstream declaration. Keep its small trusted
// constructor contract local so every consuming workspace type-checks it.
const JSDOMParser = createRequire(import.meta.url)(
    '@mozilla/readability/JSDOMParser.js',
) as new () => {
    parse(markup: string, url?: string): Document;
};

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
    let dom = new JSDOM(response.body, { url: response.url, virtualConsole });
    try {
        let document = dom.window.document;
        const exceedsStructureLimit = document.getElementsByTagName('*').length > 20_000;
        // No ruby wrappers means normalization cannot recover this structure.
        // Reject it before metadata scans and a pointless serialization pass.
        if (exceedsStructureLimit && !document.getElementsByTagName('ruby').length)
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
        if (exceedsStructureLimit) {
            const normalized = compactRubyMarkup(document);
            dom.window.close();
            dom = new JSDOM(normalized, { url: response.url, virtualConsole });
            document = dom.window.document;
            if (document.getElementsByTagName('*').length > 20_000)
                throw new ConnectorError('extraction_failed', '网页节点数超过提取限制');
        }
        // Check gates before forms are removed; the script markers themselves
        // are never retained as body evidence or executed by this extractor.
        document.querySelectorAll('script,style,iframe,object,embed,noscript').forEach((node) => {
            node.remove();
        });
        const limitations = checkPageQuality(document, response.body);
        const links = [
            ...(selectPageContent(document) ?? document.body).querySelectorAll('a[href]'),
        ]
            .flatMap((anchor) => {
                try {
                    const target = new URL(anchor.getAttribute('href')!, response.url);
                    const source = new URL(response.url);
                    const text = (anchor.textContent ?? '')
                        .trim()
                        .replace(/\s+/g, ' ')
                        .slice(0, 200);
                    if (
                        !text ||
                        target.href.length > 4000 ||
                        !['http:', 'https:'].includes(target.protocol) ||
                        target.username ||
                        target.password ||
                        (target.origin === source.origin &&
                            target.pathname === source.pathname &&
                            target.search === source.search)
                    )
                        return [];
                    target.hash = '';
                    return [{ url: normalizeUrl(target.href), text }];
                } catch {
                    return [];
                }
            })
            .filter((link, index, all) => all.findIndex((x) => x.url === link.url) === index)
            .slice(0, 80);
        document.querySelectorAll('form').forEach((node) => node.remove());
        // Readability mutates thousands of nodes. JSDOM's live collection
        // bookkeeping can make ordinary long articles quadratic. Its bundled
        // lightweight DOM has snapshot lists; feed it canonical XML so named
        // entities and malformed source HTML retain the browser-parsed text.
        let fullText = primaryPageText(document);
        let fallbackTitle = '';
        if (!fullText) {
            preparePageFallback(document);
            const serialized = new dom.window.XMLSerializer().serializeToString(document);
            const extractionDocument = new JSDOMParser().parse(serialized, response.url);
            const article = new Readability(extractionDocument, {
                charThreshold: 0,
                maxElemsToParse: 20_000,
            }).parse();
            fallbackTitle = article?.title ?? '';
            if (article?.content)
                fullText = serializePageText(
                    new JSDOMParser().parse(article.content, response.url),
                );
        }
        if (!fullText) throw new ConnectorError('extraction_failed', '网页没有可提取正文');
        // Keep the snapshot and its offsets intact; avoid a dangling UTF-16 surrogate.
        let text = fullText.slice(0, maxText);
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        return {
            kind: 'read_page' as const,
            mode: 'live' as const,
            originalUrl,
            fetchedUrl: response.url,
            url: normalizeUrl(response.url),
            title: getPageTitle(document, fallbackTitle),
            text,
            contentHash: pageFingerprint(text),
            extractionVersion,
            collectedAt: new Date().toISOString(),
            truncated: fullText.length > maxText,
            publication,
            ...(links.length ? { links } : {}),
            ...(limitations.length
                ? {
                      collection: {
                          version: 1 as const,
                          method: 'html' as const,
                          complete: false,
                          limitations,
                      },
                  }
                : {}),
            untrusted: true as const,
        };
    } finally {
        dom.window.close();
    }
}
