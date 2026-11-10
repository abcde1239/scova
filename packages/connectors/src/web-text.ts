import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { ConnectorError } from './types.ts';

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
    } catch {
        throw new ConnectorError('invalid_response', '网页压缩格式无效或解压超过限制');
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
    const meta = /^text\/html/i.test(contentType)
        ? bytes
              .subarray(0, 4096)
              .toString('latin1')
              .match(/<meta\b[^>]*charset\s*=\s*["']?\s*([a-z0-9_-]+)/i)?.[1]
        : undefined;
    let body: string;
    try {
        body = new TextDecoder(declared ?? meta ?? 'utf-8', { fatal: true }).decode(bytes);
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
