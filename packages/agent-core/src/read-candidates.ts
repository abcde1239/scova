export type UnsupportedReadCandidate = 'document' | 'attachment';

const unsupportedFile =
    /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub|mobi|txt|csv|tsv|dic|zip|rar|7z|tar|gz|exe|dmg|iso|mp[34]|webm|wav|jpe?g|png|gif|webp|svg)(?:$|[;/])/i;

/** A conservative URL capability check, not an assertion about the source's truth or relevance. */
export function unsupportedReadCandidate(value: string): UnsupportedReadCandidate | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null; // The caller retains its existing URL safety policy.
    }
    let pathname = url.pathname;
    try {
        pathname = decodeURIComponent(pathname);
    } catch {
        /* Leave malformed escapes to URL safety. */
    }
    if (/\.x?html?$/i.test(pathname)) return null;
    if (unsupportedFile.test(pathname)) return 'document';
    for (const key of ['filename', 'file', 'attachment', 'download', 'path']) {
        const name = url.searchParams.get(key);
        if (name && unsupportedFile.test(name.split(/[?#]/, 1)[0]!)) return 'document';
    }
    if (/^(?:pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i.test(url.searchParams.get('format') ?? ''))
        return 'document';
    // Extensionless forum attachments (including dictionary/word-list downloads) are not HTML articles.
    if (
        /\/nforum\/att\//i.test(pathname) ||
        /\/(?:attachment|attachments)(?:\.php|\/)/i.test(pathname) ||
        (/(?:forum|download)\.php$/i.test(pathname) && url.searchParams.get('mod') === 'attachment')
    )
        return 'attachment';
    return null;
}

/** Provider bodies have their own read-stage verification; do not discard that capability by URL suffix. */
export function unsupportedSearchReadCandidate(
    result: {
        originalUrl: string;
        url: string;
        page?: { kind: string; text: string };
    },
    providerBodyAvailable = false,
): UnsupportedReadCandidate | null {
    if (providerBodyAvailable) return null;
    if (
        result.page?.kind === 'read_page' &&
        typeof result.page.text === 'string' &&
        result.page.text.trim()
    )
        return null;
    return unsupportedReadCandidate(result.originalUrl) ?? unsupportedReadCandidate(result.url);
}
