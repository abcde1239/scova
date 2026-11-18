import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vite-plus/test';
import { decodeWebText } from '../src/reader/extraction/web-text.ts';

describe('bounded browser text decoding', () => {
    it.each([
        ['gzip', gzipSync],
        ['br', brotliCompressSync],
        ['deflate', deflateSync],
    ] as const)('decodes %s and removes stale encoding/length', (encoding, compress) => {
        const body = '<article>中文网页正文</article>';
        const bytes = compress(Buffer.from(body));
        const result = decodeWebText(
            bytes,
            {
                'content-type': 'text/html',
                'content-encoding': encoding,
                'content-length': String(bytes.length),
            },
            2048,
        );
        expect(result.body).toBe(body);
        expect(result.headers).toEqual({ 'content-type': 'text/html; charset=utf-8' });
    });
    it.each(['text/html; charset=gb18030', 'text/html; charset=gb2312'])(
        'decodes Chinese legacy encoding %s into UTF-8',
        (type) => {
            expect(
                decodeWebText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), { 'content-type': type }, 2048)
                    .body,
            ).toBe('中文');
        },
    );
    it('sniffs an HTML meta charset without running page scripts', () => {
        const bytes = Buffer.concat([
            Buffer.from('<meta charset="gb18030"><article>'),
            Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
            Buffer.from('</article>'),
        ]);
        expect(decodeWebText(bytes, { 'content-type': 'text/html' }, 2048).body).toContain('中文');
    });
    it.each([
        '<!-- <meta charset="windows-1252"> -->',
        '<script>const example="<meta charset=windows-1252>";</script>',
        '<style>p::after { content:"<meta charset=windows-1252>" }</style>',
        '<div data-example="<meta charset=windows-1252>"></div>',
        '<textarea><meta charset=windows-1252></textarea>',
    ])('does not sniff a fake meta inside %s', (prefix) => {
        const html = `${prefix}<meta charset=utf-8><article>中文正文 😀</article>`;
        expect(decodeWebText(Buffer.from(html), { 'content-type': 'text/html' }, 2048).body).toBe(
            html,
        );
    });
    it('accepts real HTTP-equivalent meta declarations and leaves quoted values intact', () => {
        const bytes = Buffer.concat([
            Buffer.from(
                '<meta data-example="x>y" content="text/html; charset=gbk" http-equiv="Content-Type"><article>',
            ),
            Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
            Buffer.from('</article>'),
        ]);
        expect(decodeWebText(bytes, { 'content-type': 'text/html' }, 2048).body).toContain('中文');
    });
    it.each(['utf-8', 'utf-16le', 'utf-16be'])(
        'uses %s BOM before conflicting HTTP or HTML declarations',
        (charset) => {
            const html = '<meta charset=windows-1252><article>中文正文 😀</article>';
            const bytes =
                charset === 'utf-8'
                    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html)])
                    : Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, 'utf16le')]);
            if (charset === 'utf-16be') bytes.swap16();
            expect(
                decodeWebText(bytes, { 'content-type': 'text/html; charset=windows-1252' }, 2048)
                    .body,
            ).toBe(html);
        },
    );
    it('decodes BOM-less XML using its declaration instead of HTML meta', () => {
        const bytes = Buffer.concat([
            Buffer.from(
                '<?xml version="1.0" encoding="gbk"?><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="windows-1252" /></head><body>',
            ),
            Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
            Buffer.from('</body></html>'),
        ]);
        expect(
            decodeWebText(bytes, { 'content-type': 'application/xhtml+xml' }, 2048).body,
        ).toContain('中文');
    });
    it('rejects decompression bombs, broken compressed streams, binary types and invalid text', () => {
        expect(() =>
            decodeWebText(
                gzipSync(Buffer.alloc(8192)),
                { 'content-type': 'text/html', 'content-encoding': 'gzip' },
                1024,
            ),
        ).toThrow();
        expect(() =>
            decodeWebText(
                gzipSync(Buffer.alloc(8192)),
                { 'content-type': 'text/html', 'content-encoding': 'gzip' },
                1024,
            ),
        ).toThrow(expect.objectContaining({ code: 'response_too_large' }));
        expect(() =>
            decodeWebText(
                Buffer.from('broken'),
                { 'content-type': 'text/html', 'content-encoding': 'br' },
                1024,
            ),
        ).toThrow(expect.objectContaining({ code: 'invalid_response' }));
        expect(() =>
            decodeWebText(
                Buffer.from('broken'),
                { 'content-type': 'text/html', 'content-encoding': 'br' },
                1024,
            ),
        ).toThrow();
        expect(() =>
            decodeWebText(Buffer.alloc(8), { 'content-type': 'image/png' }, 1024),
        ).toThrow();
        expect(() =>
            decodeWebText(Buffer.from([0xff]), { 'content-type': 'text/html' }, 1024),
        ).toThrow();
        expect(() =>
            decodeWebText(
                Buffer.from('ok'),
                { 'content-type': 'text/html; charset=unsupported-private-encoding' },
                1024,
            ),
        ).toThrow();
    });
    it('bounds the UTF-8 result as well as raw/expanded bytes', () => {
        expect(() =>
            decodeWebText(
                Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
                { 'content-type': 'text/html; charset=gb18030' },
                5,
            ),
        ).toThrow();
    });
});
