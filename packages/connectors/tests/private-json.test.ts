import { describe, expect, it } from 'vite-plus/test';
import { createDelegatedReader } from '../src/browser-delegate.ts';
import { pageFingerprint } from '../src/page-extraction.ts';
import { privateJsonLine } from '../src/private-json.ts';

describe('private Reader JSONL frames', () => {
    it('escapes framing characters without changing decoded evidence', () => {
        const value = { text: 'one\u2028two\u2029three\nfour' };
        const wire = privateJsonLine(value);
        expect(wire).not.toContain('\u2028');
        expect(wire).not.toContain('\u2029');
        expect(wire.split('\n')).toHaveLength(2);
        expect(JSON.parse(wire)).toEqual(value);
    });
    it('round-trips Unicode line separators through the real Node Reader host', async () => {
        const code = 'first\u2028second\u2029third';
        const reader = createDelegatedReader({
            http: {
                request: async (url) => ({
                    url,
                    status: 200,
                    headers: { 'content-type': 'text/html; charset=utf-8' },
                    body: `<title>Private transport</title><main><p>${'Controlled evidence. '.repeat(7000)}</p><pre>${code}</pre></main>`,
                }),
            },
        });
        try {
            const page = await reader.read('https://fixture.example/article');
            expect(page.text).toContain(code);
            expect(page.contentHash).toBe(pageFingerprint(page.text));
        } finally {
            await reader.close?.();
        }
    });
});
