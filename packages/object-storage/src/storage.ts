import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ObjectStorageError } from './core/errors.ts';
import type { ObjectStorage, ObjectStorageConfig, ObjectStorageScope } from './core/types.ts';
import { expiresIn, parseBaseUrl, validateKey } from './core/validation.ts';
import { uploadKey } from './core/keys.ts';
import { resolvePolicy, tightenPolicy, validateFile, type ResolvedPolicy } from './core/policy.ts';
import { createS3Client } from './providers/s3.ts';

export function createObjectStorage(config: ObjectStorageConfig): ObjectStorage {
    const prefix = config.keyPrefix === undefined ? '' : validateKey(config.keyPrefix);
    const publicBase =
        config.publicBaseUrl === undefined ? null : parseBaseUrl(config.publicBaseUrl);
    resolvePolicy(config);
    const client = createS3Client(config);
    const bucket = config.bucket;
    let closed = false;
    const assertOpen = () => {
        if (closed)
            throw new ObjectStorageError('storage_closed', 'Object storage has been closed.');
    };
    const request = async <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        assertOpen();
        try {
            signal?.throwIfAborted();
            return await run();
        } catch (error) {
            const upstream = error as {
                name?: string;
                $metadata?: { httpStatusCode?: number };
            } | null;
            if (signal?.aborted || upstream?.name === 'AbortError') {
                throw new ObjectStorageError(
                    'request_aborted',
                    'Object storage request was aborted.',
                );
            }
            const status = upstream?.$metadata?.httpStatusCode;
            throw new ObjectStorageError(
                'storage_request_failed',
                'Object storage request failed.',
                typeof status === 'number' && status >= 400 && status <= 599 ? status : undefined,
            );
        }
    };
    const view = (prefix: string, policy: ResolvedPolicy): ObjectStorageScope => {
        const objectKey = (key: string) => {
            assertOpen();
            validateKey(key);
            if (prefix && !key.startsWith(`${prefix}/`)) {
                throw new ObjectStorageError(
                    'invalid_key',
                    'Object key is outside the configured prefix.',
                );
            }
            return key;
        };
        const publicUrl = (key: string) => {
            objectKey(key);
            if (!publicBase) return null;
            // Encode each segment; a key beginning with // can never replace the public origin.
            const encoded = key
                .split('/')
                .map((part) =>
                    encodeURIComponent(part).replace(
                        /[!'()*]/g,
                        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
                    ),
                )
                .join('/');
            return `${publicBase}/${encoded}`;
        };
        return {
            scope(directory, nextPolicy = {}) {
                assertOpen();
                const childPrefix = uploadKey(prefix, validateKey(directory));
                return view(childPrefix, tightenPolicy(policy, nextPolicy));
            },
            async upload(input) {
                assertOpen();
                if (!(input.body instanceof Uint8Array)) {
                    throw new ObjectStorageError('invalid_file', 'File body must be a Uint8Array.');
                }
                validateFile(input.body.byteLength, input.contentType, policy);
                const body = new Uint8Array(input.body);
                const contentType = input.contentType;
                if (
                    input.cacheControl !== undefined &&
                    // oxlint-disable-next-line no-control-regex -- Forbid control bytes in HTTP headers.
                    /[\x00-\x1f\x7f]/.test(input.cacheControl)
                ) {
                    throw new ObjectStorageError('invalid_file', 'Invalid cache control.');
                }
                const key = uploadKey(prefix, input.key);
                const result = await request(
                    () =>
                        client.send(
                            new PutObjectCommand({
                                Bucket: bucket,
                                Key: key,
                                Body: body,
                                ContentType: contentType,
                                ContentLength: body.byteLength,
                                CacheControl: input.cacheControl,
                            }),
                            { abortSignal: input.signal },
                        ),
                    input.signal,
                );
                return {
                    key,
                    url: publicUrl(key),
                    contentType,
                    size: body.byteLength,
                    etag: result.ETag,
                };
            },
            async head(key, options = {}) {
                objectKey(key);
                try {
                    const result = await request(
                        () =>
                            client.send(
                                new HeadObjectCommand({
                                    Bucket: bucket,
                                    Key: key,
                                }),
                                { abortSignal: options.signal },
                            ),
                        options.signal,
                    );
                    return {
                        key,
                        url: publicUrl(key),
                        contentType: result.ContentType,
                        size: result.ContentLength,
                        etag: result.ETag,
                        lastModified: result.LastModified,
                    };
                } catch (error) {
                    if (error instanceof ObjectStorageError && error.statusCode === 404)
                        return null;
                    throw error;
                }
            },
            async download(key, options = {}) {
                objectKey(key);
                const result = await request(
                    () =>
                        client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
                            abortSignal: options.signal,
                        }),
                    options.signal,
                );
                if (!result.Body)
                    throw new ObjectStorageError(
                        'storage_request_failed',
                        'Object response has no body.',
                    );
                return { body: result.Body.transformToWebStream(), size: result.ContentLength };
            },
            async delete(key, options = {}) {
                objectKey(key);
                await request(
                    () =>
                        client.send(
                            new DeleteObjectCommand({
                                Bucket: bucket,
                                Key: key,
                            }),
                            { abortSignal: options.signal },
                        ),
                    options.signal,
                );
            },
            getPublicUrl: publicUrl,
            async presignUpload(input) {
                assertOpen();
                const { contentType, size } = input;
                validateFile(size, contentType, policy);
                const key = uploadKey(prefix, input.key);
                const ttl = expiresIn(input.expiresIn);
                const url = await request(() =>
                    getSignedUrl(
                        client,
                        new PutObjectCommand({
                            Bucket: bucket,
                            Key: key,
                            ContentType: contentType,
                            ContentLength: size,
                        }),
                        { expiresIn: ttl, signableHeaders: new Set(['content-type']) },
                    ),
                );
                return {
                    key,
                    url,
                    publicUrl: publicUrl(key),
                    method: 'PUT',
                    headers: { 'Content-Type': contentType },
                    size,
                    expiresIn: ttl,
                };
            },
            async presignDownload(key, options = {}) {
                objectKey(key);
                const ttl = expiresIn(options.expiresIn);
                return request(() =>
                    getSignedUrl(
                        client,
                        new GetObjectCommand({
                            Bucket: bucket,
                            Key: key,
                        }),
                        { expiresIn: ttl },
                    ),
                );
            },
        };
    };
    const root = view(prefix, resolvePolicy(config));
    return {
        ...root,
        destroy() {
            if (closed) return;
            closed = true;
            client.destroy();
        },
    };
}
