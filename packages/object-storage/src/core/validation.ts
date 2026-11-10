import { ObjectStorageError } from './errors.ts';
export function validateKey(key: string): string {
    if (
        typeof key !== 'string' ||
        Buffer.byteLength(key, 'utf8') > 1024 ||
        key.includes('\\') ||
        // oxlint-disable-next-line no-control-regex -- Object keys explicitly forbid ASCII control bytes.
        /[\u0000-\u001f\u007f]/.test(key) ||
        key.split('/').some((part) => !part || part === '.' || part === '..') ||
        // Reject malformed UTF-16 rather than silently changing keys during URL encoding.
        !key.isWellFormed()
    ) {
        throw new ObjectStorageError('invalid_key', 'Invalid object key.');
    }
    return key;
}

export function expiresIn(value = 900): number {
    if (!Number.isInteger(value) || value < 1 || value > 3600) {
        throw new ObjectStorageError(
            'invalid_expiry',
            'URL expiry must be between 1 and 3600 seconds.',
        );
    }
    return value;
}

export function parseBaseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new ObjectStorageError('invalid_config', 'Invalid storage URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new ObjectStorageError(
            'invalid_config',
            'Storage URLs must use HTTPS without credentials, query or fragment.',
        );
    }
    return url.href.replace(/\/+$/, '');
}
