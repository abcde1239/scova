import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { ConnectorError } from '../../types.ts';

/** Only inspect actual tags: comments, quoted attributes and raw-text content are not metadata. */
function htmlCharset(prefix: string): string | undefined {
    const tags = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][a-z0-9:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
    let raw: string | undefined;
    for (const tag of prefix.matchAll(tags)) {
        if (!tag[1]) continue;
        const name = tag[1].toLowerCase();
        const closing = tag[0].startsWith('</');
        if (raw) {
            if (closing && name === raw) raw = undefined;
            continue;
        }
        if (closing) continue;
        if (/^(?:script|style|title|textarea|xmp|iframe|noembed|noframes|noscript)$/.test(name)) {
            raw = name;
            continue;
        }
        if (name !== 'meta') continue;
        const attributes = new Map<string, string>();
        const values = tag[0].slice(5, -1);
        for (const attribute of values.matchAll(
            /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
        )) {
            const key = attribute[1].toLowerCase();
            if (!attributes.has(key))
                attributes.set(key, attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
        }
        const charset =
            attributes.get('charset') ??
            (attributes.get('http-equiv')?.toLowerCase() === 'content-type'
                ? attributes.get('content')?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]
                : undefined);
        if (charset?.trim()) {
            // An ASCII-compatible HTML meta declaration cannot signal UTF-16 bytes.
            return /^utf-?16(?:le|be)?$/i.test(charset.trim()) ? 'utf-8' : charset.trim();
        }
    }
    return undefined;
}

function byteOrderCharset(bytes: Buffer): string | undefined {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
    if (
        (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
        (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
    )
        throw new ConnectorError('invalid_response', '网页 UTF-32 编码不支持');
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    return undefined;
}

/** Browser bridge accepts text only; both compressed and expanded bytes remain bounded. */
export function decodeWebText(bytes: Buffer, headers: Record<string, string>, maxBytes: number) {
    const encoding = headers['content-encoding']?.toLowerCase().trim();
    try {
        if (encoding && encoding !== 'identity') {
            const decode = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync }[
                encoding
            ];
            if (!decode) throw new Error();
            bytes = decode(bytes, { maxOutputLength: maxBytes });
        }
    } catch (error) {
        if (error instanceof Error && Reflect.get(error, 'code') === 'ERR_BUFFER_TOO_LARGE')
            throw new ConnectorError('response_too_large', '网页解压后超过下载限制');
        throw new ConnectorError('invalid_response', '网页压缩格式无效');
    }
    if (bytes.length > maxBytes) throw new ConnectorError('response_too_large', '网页超过下载限制');
    const contentType = headers['content-type'] ?? '';
    if (
        !/^(text\/(html|plain|css|javascript)|application\/(xhtml\+xml|javascript|x-javascript|json|[^;]+\+json))(;|$)/i.test(
            contentType,
        )
    )
        throw new ConnectorError('invalid_response', '浏览器读取仅允许网页文本资源');
    const declared = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
    const prefix = bytes.subarray(0, 4096).toString('latin1');
    const meta = /^text\/html/i.test(contentType)
        ? htmlCharset(prefix)
        : /^application\/xhtml\+xml/i.test(contentType)
          ? prefix.match(/^<\?xml\s+[^?]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1]
          : undefined;
    let body: string;
    try {
        body = new TextDecoder(byteOrderCharset(bytes) ?? declared ?? meta ?? 'utf-8', {
            fatal: true,
        }).decode(bytes);
    } catch {
        throw new ConnectorError('invalid_response', '网页文本编码不支持或内容无效');
    }
    if (Buffer.byteLength(body, 'utf8') > maxBytes)
        throw new ConnectorError('response_too_large', '转码后的网页超过限制');
    const safeHeaders: Record<string, string> = {
        ...headers,
        'content-type': `${contentType.split(';')[0]}; charset=utf-8`,
    };
    delete safeHeaders['content-encoding'];
    delete safeHeaders['content-length'];
    return { body, headers: safeHeaders };
}
