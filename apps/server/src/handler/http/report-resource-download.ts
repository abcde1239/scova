export function reportResourceDownload(content: Uint8Array, mime: string, filename: string) {
    const encoded = encodeURIComponent(filename).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(Uint8Array.from(content), {
        headers: {
            'content-type': mime,
            'content-disposition': `attachment; filename*=UTF-8''${encoded}`,
            'content-length': String(content.byteLength),
            'cache-control': 'private, no-store',
            'content-security-policy': "default-src 'none'; sandbox",
            'x-content-type-options': 'nosniff',
        },
    });
}
