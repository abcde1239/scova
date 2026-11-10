import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    DeleteObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { createImageStorage, ImageStorageError } from '../src/index.ts';
import type { ImageStorage, ImageStorageConfig } from '../src/index.ts';

const accountId = 'a'.repeat(32);
const config: ImageStorageConfig = {
    provider: 'r2',
    accountId,
    bucket: 'images',
    credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
    publicBaseUrl: 'https://images.example.com/assets/',
    keyPrefix: 'scova',
};
// Header fixtures intentionally test signature identification, not image decoding.
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const stores: ImageStorage[] = [];
const storage = (overrides: Partial<ImageStorageConfig> = {}) => {
    const store = createImageStorage({ ...config, ...overrides } as ImageStorageConfig);
    stores.push(store);
    return store;
};
afterEach(() => {
    for (const store of stores.splice(0)) store.destroy();
    vi.restoreAllMocks();
});

describe('image upload and object operations', () => {
    it.each([
        [png, 'image/png', 'png'],
        [Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg', 'jpg'],
        [Buffer.from('GIF87a'), 'image/gif', 'gif'],
        [Buffer.from('GIF89a'), 'image/gif', 'gif'],
        [Buffer.from('RIFF1234WEBP'), 'image/webp', 'webp'],
    ])(
        'uploads detected %s as %s with a generated extension',
        async (body, contentType, extension) => {
            const send = vi
                .spyOn(S3Client.prototype, 'send')
                .mockResolvedValue({ ETag: '"etag"' } as never);
            const result = await storage().upload({ body });
            expect(result).toMatchObject({ contentType, size: body.byteLength, etag: '"etag"' });
            expect(result.key).toMatch(new RegExp(`^scova/[0-9a-f-]{36}\\.${extension}$`));
            expect(result.url).toBe(`https://images.example.com/assets/${result.key}`);
            const command = send.mock.calls[0]![0] as PutObjectCommand;
            expect(command).toBeInstanceOf(PutObjectCommand);
            expect(command.input).toMatchObject({
                Bucket: 'images',
                Key: result.key,
                ContentType: contentType,
                ContentLength: body.byteLength,
                Body: new Uint8Array(body),
            });
            expect(command.input).not.toHaveProperty('ACL');
            expect(command.input.Body).not.toBe(body);
        },
    );

    it('preserves explicit filenames, cache headers, and abort signals', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        const signal = new AbortController().signal;
        const result = await storage().upload({
            key: '头像/a b.png',
            body: png,
            contentType: 'image/png',
            cacheControl: 'public, max-age=60',
            signal,
        });
        expect(result.key).toBe('scova/头像/a b.png');
        expect(result.url).toBe(
            'https://images.example.com/assets/scova/%E5%A4%B4%E5%83%8F/a%20b.png',
        );
        expect((send.mock.calls[0]![0] as PutObjectCommand).input.CacheControl).toBe(
            'public, max-age=60',
        );
        expect(send.mock.calls[0]![1]).toEqual({ abortSignal: signal });
    });

    it('returns metadata and uses the full returned key without adding prefix twice', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
            ContentType: 'image/png',
            ContentLength: 123,
            ETag: 'etag',
            LastModified: new Date(0),
        } as never);
        expect(await storage().head('scova/folder/a.png')).toEqual({
            key: 'scova/folder/a.png',
            url: 'https://images.example.com/assets/scova/folder/a.png',
            contentType: 'image/png',
            size: 123,
            etag: 'etag',
            lastModified: new Date(0),
        });
        expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
        expect((send.mock.calls[0]![0] as HeadObjectCommand).input.Key).toBe('scova/folder/a.png');
    });

    it('treats only HTTP 404 as absence; preserves permission failures as errors', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send');
        send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
        const store = storage();
        expect(await store.head('scova/a.png')).toBeNull();
        send.mockRejectedValueOnce({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
        await expect(store.head('scova/a.png')).rejects.toMatchObject({
            code: 'storage_request_failed',
            statusCode: 403,
        });
    });

    it('deletes an object using its full key', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        await storage().delete('scova/a.png');
        expect(send.mock.calls[0]![0]).toBeInstanceOf(DeleteObjectCommand);
        expect((send.mock.calls[0]![0] as DeleteObjectCommand).input).toEqual({
            Bucket: 'images',
            Key: 'scova/a.png',
        });
    });

    it('rejects invalid, mismatched, oversized and active content before sending', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send');
        const store = storage({ maxSizeBytes: 8 });
        await expect(store.upload({ body: new Uint8Array() })).rejects.toMatchObject({
            code: 'invalid_image',
        });
        await expect(store.upload({ body: Buffer.from('<svg/>') })).rejects.toMatchObject({
            code: 'invalid_image',
        });
        await expect(store.upload({ body: png, contentType: 'image/jpeg' })).rejects.toMatchObject({
            code: 'invalid_image',
        });
        await expect(store.upload({ body: new Uint8Array(9) })).rejects.toMatchObject({
            code: 'image_too_large',
        });
        await expect(
            store.upload({ body: png, cacheControl: 'a\r\nInjected: b' }),
        ).rejects.toMatchObject({ code: 'invalid_image' });
        expect(send).not.toHaveBeenCalled();
    });

    it('sanitizes upstream errors, retaining only an HTTP status', async () => {
        vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
            Object.assign(new Error('test-secret https://private.example/?signature=secret'), {
                $metadata: { httpStatusCode: 503 },
                secretAccessKey: 'test-secret',
            }),
        );
        const error = await storage()
            .upload({ body: png })
            .catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(ImageStorageError);
        expect(error).toMatchObject({ code: 'storage_request_failed', statusCode: 503 });
        expect(String(error)).not.toContain('test-secret');
        expect(JSON.stringify(error)).not.toContain('signature');
        expect(error).not.toHaveProperty('cause');
    });

    it('aborts before sending and maps in-flight cancellation to a stable code', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send');
        const store = storage();
        const controller = new AbortController();
        controller.abort(new Error('private reason'));
        await expect(store.upload({ body: png, signal: controller.signal })).rejects.toMatchObject({
            code: 'request_aborted',
        });
        expect(send).not.toHaveBeenCalled();
        send.mockRejectedValueOnce({ name: 'AbortError' });
        await expect(store.delete('scova/a.png')).rejects.toMatchObject({
            code: 'request_aborted',
        });
    });

    it('destroys the client once and rejects use after shutdown', async () => {
        const destroy = vi.spyOn(S3Client.prototype, 'destroy');
        const store = storage();
        store.destroy();
        store.destroy();
        expect(destroy).toHaveBeenCalledTimes(1);
        await expect(store.upload({ body: png })).rejects.toMatchObject({ code: 'storage_closed' });
        await expect(store.head('scova/a.png')).rejects.toMatchObject({ code: 'storage_closed' });
        expect(() => store.getPublicUrl('scova/a.png')).toThrow(ImageStorageError);
    });
});

describe('keys and configuration', () => {
    it.each([
        '',
        '/a.png',
        '//other.example/a',
        'a//b',
        '../a',
        'a/../b',
        'a/./b',
        'a\\b',
        'a/',
        'a\n',
        '\ud800',
        '图'.repeat(342),
    ])('rejects unsafe key %j', async (key) => {
        const store = storage({ keyPrefix: undefined });
        expect(() => store.getPublicUrl(key)).toThrow(ImageStorageError);
        await expect(store.delete(key)).rejects.toMatchObject({ code: 'invalid_key' });
    });

    it('enforces namespace on reads, deletes and signatures', async () => {
        const store = storage();
        await expect(store.head('another/a.png')).rejects.toMatchObject({ code: 'invalid_key' });
        await expect(store.delete('scova-other/a.png')).rejects.toMatchObject({
            code: 'invalid_key',
        });
        await expect(store.presignDownload('a.png')).rejects.toMatchObject({ code: 'invalid_key' });
        await expect(store.upload({ body: png, key: '../a.png' })).rejects.toMatchObject({
            code: 'invalid_key',
        });
    });

    it('encodes reserved characters without changing origin or treating them as URL syntax', () => {
        const url = storage().getPublicUrl('scova/a?#%2e!()*.png')!;
        expect(url).toBe('https://images.example.com/assets/scova/a%3F%23%252e%21%28%29%2A.png');
        expect(new URL(url).search).toBe('');
        expect(new URL(url).hash).toBe('');
    });

    it('returns null for public URLs unless a public domain is configured', () => {
        expect(storage({ publicBaseUrl: undefined }).getPublicUrl('scova/a.png')).toBeNull();
    });

    it.each([
        { accountId: 'bad' },
        { bucket: '' },
        { maxSizeBytes: 0 },
        { maxSizeBytes: 1.5 },
        { credentials: { accessKeyId: '', secretAccessKey: 'secret' } },
        { publicBaseUrl: 'http://images.example.com' },
        { publicBaseUrl: 'https://user:secret@images.example.com' },
        { publicBaseUrl: 'https://images.example.com?secret=foo' },
        { publicBaseUrl: 'https://images.example.com/#fragment' },
    ])('rejects invalid configuration %j', (override) => {
        expect(() => storage(override)).toThrow(ImageStorageError);
    });

    it('validates S3 region and endpoint', () => {
        expect(() => storage({ provider: 's3', region: '' })).toThrow(ImageStorageError);
        expect(() =>
            storage({ provider: 's3', region: 'us-east-1', endpoint: 'file:///tmp' }),
        ).toThrow(ImageStorageError);
    });
});

describe('real SDK signatures (offline)', () => {
    it('signs R2 PUT with auto region, exact size, content type and a short expiry', async () => {
        const store = storage();
        const signed = await store.presignUpload({
            key: 'a b.png',
            contentType: 'image/png',
            size: 123,
            expiresIn: 60,
        });
        const url = new URL(signed.url);
        expect(url.hostname).toBe(`${accountId}.r2.cloudflarestorage.com`);
        expect(url.pathname).toBe('/images/scova/a%20b.png');
        expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
        expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
        expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual([
            'content-length',
            'content-type',
            'host',
        ]);
        expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
        expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
        expect(signed).toMatchObject({
            key: 'scova/a b.png',
            method: 'PUT',
            headers: { 'Content-Type': 'image/png' },
            size: 123,
            expiresIn: 60,
        });
        expect(signed.publicUrl).toBe('https://images.example.com/assets/scova/a%20b.png');
    });

    it('generates unique upload keys', async () => {
        const store = storage();
        const first = await store.presignUpload({ contentType: 'image/jpeg', size: 10 });
        const second = await store.presignUpload({ contentType: 'image/jpeg', size: 10 });
        expect(first.key).not.toBe(second.key);
        expect(first.key).toMatch(/\.jpg$/);
        expect(first.expiresIn).toBe(900);
    });

    it.each(['eu', 'fedramp'] as const)(
        'supports R2 %s jurisdiction endpoints',
        async (jurisdiction) => {
            const url = new URL(await storage({ jurisdiction }).presignDownload('scova/a.png'));
            expect(url.hostname).toBe(`${accountId}.${jurisdiction}.r2.cloudflarestorage.com`);
        },
    );

    it('signs AWS S3 with the configured region and temporary credentials', async () => {
        const store = storage({
            provider: 's3',
            region: 'ap-northeast-1',
            credentials: { ...config.credentials, sessionToken: 'temporary-token' },
        });
        const url = new URL(await store.presignDownload('scova/a.png', { expiresIn: 120 }));
        expect(url.hostname).toBe('images.s3.ap-northeast-1.amazonaws.com');
        expect(url.pathname).toBe('/scova/a.png');
        expect(url.searchParams.get('X-Amz-Security-Token')).toBe('temporary-token');
        expect(url.searchParams.get('X-Amz-Credential')).toContain(
            '/ap-northeast-1/s3/aws4_request',
        );
        expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    });

    it('supports S3-compatible HTTPS endpoints and path style', async () => {
        const store = storage({
            provider: 's3',
            region: 'us-east-1',
            endpoint: 'https://storage.example.com',
            forcePathStyle: true,
        });
        const url = new URL(await store.presignDownload('scova/a.png'));
        expect(url.hostname).toBe('storage.example.com');
        expect(url.pathname).toBe('/images/scova/a.png');
    });

    it.each([0, -1, 1.1, 3601, NaN, Infinity])('rejects expiry %j', async (ttl) => {
        const store = storage();
        await expect(
            store.presignDownload('scova/a.png', { expiresIn: ttl }),
        ).rejects.toMatchObject({ code: 'invalid_expiry' });
        await expect(
            store.presignUpload({ contentType: 'image/png', size: 1, expiresIn: ttl }),
        ).rejects.toMatchObject({ code: 'invalid_expiry' });
    });

    it('rejects unsupported direct-upload types and oversized reservations', async () => {
        const store = storage({ maxSizeBytes: 8 });
        await expect(
            store.presignUpload({ contentType: 'image/svg+xml' as 'image/png', size: 1 }),
        ).rejects.toMatchObject({ code: 'invalid_image' });
        await expect(
            store.presignUpload({ contentType: 'image/png', size: 9 }),
        ).rejects.toMatchObject({ code: 'image_too_large' });
        await expect(
            store.presignUpload({ contentType: 'image/png', size: 0 }),
        ).rejects.toMatchObject({ code: 'invalid_image' });
    });
});
