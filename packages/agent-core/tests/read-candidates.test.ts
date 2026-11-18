import { describe, expect, it } from 'vite-plus/test';
import {
    unsupportedReadCandidate,
    unsupportedSearchReadCandidate,
} from '../src/search/read-candidates.ts';

describe('HTML read candidate capabilities', () => {
    it.each([
        'https://example.org/file.PDF?token=public#page=3',
        'https://example.org/report%2Epdf',
        'https://example.org/export?filename=report.pdf',
        'https://example.org/download?file=%2Fdata%2Fwordlist.txt',
        'https://example.org/export?format=xlsx',
        'https://example.org/words.dic',
        'https://example.org/recording.mp4',
        'https://example.org/archive.zip',
    ])('skips explicit unsupported files before invoking the HTML reader: %s', (url) => {
        expect(unsupportedReadCandidate(url)).toBe('document');
    });
    it.each([
        'https://att.newsmth.net/nForum/att/Emacs/81563/431607',
        'https://example.org/forum.php?mod=attachment&aid=1',
        'https://example.org/attachments/wordlist/431607',
    ])('skips extensionless attachment endpoints: %s', (url) => {
        expect(unsupportedReadCandidate(url)).toBe('attachment');
    });
    it.each([
        'https://example.org/articles/how-to-read-pdf',
        'https://example.org/pdf/viewer.html',
        'https://example.org/report.pdf/viewer.html',
        'https://example.org/downloads',
        'https://example.org/search?q=pdf',
        'https://example.org/notice.php?id=42',
        'https://www.newsmth.net/nForum/#!article/Emacs/81563',
        'https://example.org/forum.php?mod=viewthread&tid=1',
    ])('preserves regular HTML, download indexes and forum articles: %s', (url) => {
        expect(unsupportedReadCandidate(url)).toBeNull();
    });
    it('checks both original and normalized URLs, preserving provider-extracted bodies for read-stage verification', () => {
        const candidate = {
            originalUrl: 'https://example.org/file.pdf',
            url: 'https://example.org/redirect',
        };
        expect(unsupportedSearchReadCandidate(candidate)).toBe('document');
        expect(unsupportedSearchReadCandidate(candidate, true)).toBeNull();
        expect(
            unsupportedSearchReadCandidate({
                ...candidate,
                page: { kind: 'read_page', text: 'Provider extracted article.' },
            }),
        ).toBeNull();
        expect(
            unsupportedSearchReadCandidate({
                ...candidate,
                page: { kind: 'read_page', text: ' ' },
            }),
        ).toBe('document');
    });
});
