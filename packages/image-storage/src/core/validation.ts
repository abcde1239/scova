import { ImageStorageError } from './errors.ts';
import type { ImageContentType } from './types.ts';

export const extensions: Record<ImageContentType, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
};

export function validateContentType(value: ImageContentType): void {
    if (!Object.hasOwn(extensions, value)) {
        throw new ImageStorageError('invalid_image', 'Unsupported image type.');
    }
}

export function validateSize(size: number, max: number): void {
    if (!Number.isSafeInteger(size) || size <= 0) {
        throw new ImageStorageError('invalid_image', 'Image body must not be empty.');
    }
    if (size > max) {
        throw new ImageStorageError('image_too_large', 'Image exceeds the configured size limit.');
    }
}

export function detectImageType(body: Uint8Array): ImageContentType {
    const starts = (bytes: number[]) => bytes.every((byte, index) => body[index] === byte);
    const text = (start: number, end: number) => String.fromCharCode(...body.subarray(start, end));
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif';
    if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
    throw new ImageStorageError('invalid_image', 'Unsupported image signature.');
}
