import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vite-plus/test';
import { decodeWebText } from '../src/web-text.ts';

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
