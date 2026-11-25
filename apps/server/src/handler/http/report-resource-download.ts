export function reportResourceDownload(
    content: Uint8Array | ReadableStream<Uint8Array>,
    mime: string,
    filename: string,
    byteLength = content instanceof Uint8Array ? content.byteLength : undefined,
) {
    const encoded = encodeURIComponent(filename).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(content instanceof Uint8Array ? Uint8Array.from(content) : content, {
        headers: {
            'content-type': mime,
            'content-disposition': `attachment; filename*=UTF-8''${encoded}`,
            ...(byteLength === undefined ? {} : { 'content-length': String(byteLength) }),
            'cache-control': 'private, no-store',
            'content-security-policy': "default-src 'none'; sandbox",
            'x-content-type-options': 'nosniff',
        },
    });
}
