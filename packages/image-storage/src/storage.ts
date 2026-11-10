import { randomUUID } from 'node:crypto';
import {
    createObjectStorage,
    ObjectStorageError,
    type ObjectStorageScope,
} from '@scova/object-storage';
import { ImageStorageError } from './core/errors.ts';
import type {
    ImageStorage,
    ImageStorageClient,
    ImageStorageConfig,
    ImageContentType,
} from './core/types.ts';
import {
    detectImageType,
    extensions,
    validateContentType,
    validateSize,
} from './core/validation.ts';

function guard<T>(run: () => T): T {
    try {
        return run();
    } catch (error) {
        throw imageError(error);
    }
}

function imageError(error: unknown): unknown {
    if (!(error instanceof ObjectStorageError)) return error;
    const code =
        error.code === 'invalid_file'
            ? 'invalid_image'
            : error.code === 'file_too_large'
              ? 'image_too_large'
              : error.code;
    return new ImageStorageError(code, error.message, error.statusCode);
}

async function request<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        throw imageError(error);
    }
}

/** An image view borrows a scope; only the bucket owner may close its client. */
export function createImageStorageView(
    objects: ObjectStorageScope,
    options: { maxSizeBytes?: number } = {},
): ImageStorageClient {
    const max = options.maxSizeBytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max <= 0)
        throw new ImageStorageError('invalid_config', 'Invalid image size limit.');
    const key = (value: string | undefined, type: ImageContentType) =>
        value ?? `${randomUUID()}.${extensions[type]}`;
    return {
        upload: (input) =>
            request(async () => {
                if (!(input.body instanceof Uint8Array))
                    throw new ImageStorageError(
                        'invalid_image',
                        'Image body must be a Uint8Array.',
                    );
                validateSize(input.body.byteLength, max);
                const body = new Uint8Array(input.body);
                const contentType = detectImageType(body);
                if (input.contentType !== undefined && input.contentType !== contentType)
                    throw new ImageStorageError(
                        'invalid_image',
                        'Image content type does not match its signature.',
                    );
                const result = await objects.upload({
                    ...input,
                    body,
                    contentType,
                    key: key(input.key, contentType),
                });
                return { ...result, contentType };
            }),
        head: (key, options) => request(() => objects.head(key, options)),
        delete: (key, options) => request(() => objects.delete(key, options)),
        getPublicUrl: (key) => guard(() => objects.getPublicUrl(key)),
        presignDownload: (key, options) => request(() => objects.presignDownload(key, options)),
        presignUpload: (input) =>
            request(async () => {
                validateContentType(input.contentType);
                validateSize(input.size, max);
                const result = await objects.presignUpload({
                    ...input,
                    key: key(input.key, input.contentType),
                });
                return { ...result, headers: { 'Content-Type': input.contentType } };
            }),
    };
}

export function createImageStorage(config: ImageStorageConfig): ImageStorage {
    return guard(() => {
        const objects = createObjectStorage({
            ...config,
            maxSizeBytes: config.maxSizeBytes ?? 10 * 1024 * 1024,
        });
        return { ...createImageStorageView(objects, config), destroy: () => objects.destroy() };
    });
}
