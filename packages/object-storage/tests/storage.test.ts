import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
    createObjectStorage,
    createStorageKey,
    ObjectStorageError,
    type ObjectStorage,
    type ObjectStorageConfig,
} from '../src/index.ts';

const config: ObjectStorageConfig = {
    provider: 'r2',
    accountId: 'a'.repeat(32),
    bucket: 'files',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test-secret' },
    keyPrefix: 'scova',
};
const stores: ObjectStorage[] = [];
const storage = (overrides: Partial<ObjectStorageConfig> = {}) => {
    const store = createObjectStorage({ ...config, ...overrides } as ObjectStorageConfig);
    stores.push(store);
    return store;
};
afterEach(() => {
    stores.splice(0).forEach((store) => store.destroy());
    vi.restoreAllMocks();
});

describe('通用文件与用途目录', () => {
    it.each([
        ['tasks/task-id/input.txt', 'text/plain', 'input'],
        ['reports/report-id/result.pdf', 'application/pdf', '%PDF-1.7'],
        ['reports/report-id/result.json', 'application/json', '{}'],
        ['tasks/task-id/archive.zip', 'application/zip', 'PK'],
    ])('uploads %s without image assumptions', async (key, contentType, text) => {
        const send = vi
            .spyOn(S3Client.prototype, 'send')
            .mockResolvedValue({ ETag: 'etag' } as never);
        const store = storage();
        const body = Buffer.from(text);
        const result = await store.upload({ key, contentType, body });
        body.fill(0);
        expect(result).toMatchObject({
            key: `scova/${key}`,
            contentType,
            size: text.length,
            url: null,
        });
        const command = send.mock.calls[0]![0] as PutObjectCommand;
        expect(command.input.Body).toEqual(new Uint8Array(Buffer.from(text)));
        expect(command.input).toMatchObject({
            ContentType: contentType,
            ContentLength: text.length,
        });
    });

    it('returns a private object as a cancellable web stream', async () => {
        const body = new Response('abc').body!;
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
            Body: { transformToWebStream: () => body },
            ContentLength: 3,
        } as never);
        const signal = new AbortController().signal;
        const result = await storage().download('scova/reports/object', { signal });
        const command = send.mock.calls[0]![0] as GetObjectCommand;
        expect(command.input).toEqual({ Bucket: 'files', Key: 'scova/reports/object' });
        expect(send).toHaveBeenCalledWith(expect.any(GetObjectCommand), { abortSignal: signal });
        expect(result.size).toBe(3);
        expect(await new Response(result.body).text()).toBe('abc');
    });

    it('nested scopes keep returned full keys and forbid sibling access on every read operation', async () => {
        vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: 1 } as never);
        const root = storage();
        const task = root.scope('tasks').scope('task-1');
        const result = await task.upload({
            key: 'a.txt',
            contentType: 'text/plain',
            body: new Uint8Array(1),
        });
        expect(result.key).toBe('scova/tasks/task-1/a.txt');
        expect((await task.head(result.key))?.key).toBe(result.key);
        await task.delete(result.key);
        expect(new URL(await task.presignDownload(result.key)).pathname).toBe(
            '/files/scova/tasks/task-1/a.txt',
        );
        for (const key of [
            'scova/tasks/task-10/a',
            'scova/reports/a',
            'scova/tasks/task-1',
            'a.txt',
        ]) {
            await expect(task.head(key)).rejects.toMatchObject({ code: 'invalid_key' });
            await expect(task.download(key)).rejects.toMatchObject({ code: 'invalid_key' });
            await expect(task.delete(key)).rejects.toMatchObject({ code: 'invalid_key' });
            await expect(task.presignDownload(key)).rejects.toMatchObject({ code: 'invalid_key' });
            expect(() => task.getPublicUrl(key)).toThrow(ObjectStorageError);
        }
        expect(() => root.scope('../reports')).toThrow(ObjectStorageError);
        await expect(
            task.upload({
                key: '../../reports/a',
                body: new Uint8Array(1),
                contentType: 'text/plain',
            }),
        ).rejects.toMatchObject({ code: 'invalid_key' });
    });

    it('snapshots and tightens policies for both server uploads and signed uploads', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send');
        const allowed = ['text/plain', 'application/pdf'];
        const root = storage({ maxSizeBytes: 10, allowedContentTypes: allowed });
        allowed.push('application/zip');
        const reports = root.scope('reports', {
            maxSizeBytes: 5,
            allowedContentTypes: ['application/pdf'],
        });
        for (const invoke of [
            () => reports.upload({ body: new Uint8Array(6), contentType: 'application/pdf' }),
            () => reports.presignUpload({ size: 6, contentType: 'application/pdf' }),
        ])
            await expect(invoke()).rejects.toMatchObject({ code: 'file_too_large' });
        await expect(
            reports.upload({ body: new Uint8Array(1), contentType: 'text/plain' }),
        ).rejects.toMatchObject({ code: 'invalid_file' });
        await expect(
            reports.presignUpload({ size: 1, contentType: 'application/zip' }),
        ).rejects.toMatchObject({ code: 'invalid_file' });
        expect(() => reports.scope('one', { maxSizeBytes: 6 })).toThrow(ObjectStorageError);
        expect(() => reports.scope('one', { allowedContentTypes: ['text/plain'] })).toThrow(
            ObjectStorageError,
        );
        expect(() => reports.scope('one', { allowedContentTypes: undefined })).toThrow(
            ObjectStorageError,
        );
        expect(() => root.scope('zip', { allowedContentTypes: ['application/zip'] })).toThrow(
            ObjectStorageError,
        );
        expect(send).not.toHaveBeenCalled();
    });

    it('shares one lifecycle; child views cannot close the client', async () => {
        const destroy = vi.spyOn(S3Client.prototype, 'destroy');
        const root = storage();
        const child = root.scope('tasks');
        expect(child).not.toHaveProperty('destroy');
        root.destroy();
        root.destroy();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(() => child.scope('more')).toThrow(ObjectStorageError);
        await expect(
            child.upload({ body: new Uint8Array(1), contentType: 'text/plain' }),
        ).rejects.toMatchObject({ code: 'storage_closed' });
        await expect(
            child.presignUpload({ size: 1, contentType: 'text/plain' }),
        ).rejects.toMatchObject({ code: 'storage_closed' });
    });

    it('signs arbitrary MIME with exact length and no public access by default', async () => {
        const signed = await storage().scope('reports').presignUpload({
            key: 'a.pdf',
            size: 9,
            contentType: 'application/pdf',
            expiresIn: 300,
        });
        const url = new URL(signed.url);
        expect(url.pathname).toBe('/files/scova/reports/a.pdf');
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
            'content-length;content-type;host',
        );
        expect(signed).toMatchObject({
            size: 9,
            publicUrl: null,
            headers: { 'Content-Type': 'application/pdf' },
        });
    });

    it('supports empty generic files, unique UUID keys and denies MIME/header injection', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
        const store = storage();
        const result = await store.upload({ body: new Uint8Array(), contentType: 'text/plain' });
        expect(result.key).toMatch(/^scova\/[a-f0-9-]{36}$/);
        expect(result.size).toBe(0);
        send.mockClear();
        for (const contentType of ['text/plain\r\nX: y', '*/*', '', 'text/plain; charset=utf-8']) {
            await expect(store.presignUpload({ size: 1, contentType })).rejects.toMatchObject({
                code: 'invalid_file',
            });
        }
        await expect(
            store.upload({
                body: new Uint8Array(1),
                contentType: 'text/plain',
                cacheControl: 'a\u0000b',
            }),
        ).rejects.toMatchObject({ code: 'invalid_file' });
        expect(send).not.toHaveBeenCalled();
    });

    it('reports only 404 as missing and redacts provider details', async () => {
        const send = vi.spyOn(S3Client.prototype, 'send');
        const root = storage();
        send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
        expect(await root.head('scova/a')).toBeNull();
        send.mockRejectedValueOnce(
            Object.assign(new Error('test-secret signed-url'), {
                $metadata: { httpStatusCode: 403 },
            }),
        );
        const error = await root.head('scova/a').catch((e) => e);
        expect(error).toMatchObject({ code: 'storage_request_failed', statusCode: 403 });
        expect(String(error)).not.toContain('test-secret');
        expect(error).not.toHaveProperty('cause');
    });
});

describe('业务对象键', () => {
    it.each(['avatars', 'tasks', 'reports', 'exports'])(
        'builds extensible purpose %s',
        (purpose) => {
            expect(
                createStorageKey({
                    purpose,
                    ownerId: 'owner',
                    objectId: 'file',
                    extension: 'webp',
                }),
            ).toBe(`${purpose}/owner/file.webp`);
        },
    );
    it.each(['../user', 'a/b', '', '..', '\ud800', 'x\n'])(
        'rejects invalid component %j',
        (ownerId) => {
            expect(() => createStorageKey({ purpose: 'tasks', ownerId, objectId: 'file' })).toThrow(
                ObjectStorageError,
            );
        },
    );
    it('rejects extension paths and excessive total key length', () => {
        expect(() =>
            createStorageKey({
                purpose: 'tasks',
                ownerId: 'owner',
                objectId: 'file',
                extension: '../pdf',
            }),
        ).toThrow(ObjectStorageError);
        expect(() =>
            createStorageKey({
                purpose: 'tasks',
                ownerId: '图'.repeat(200),
                objectId: '图'.repeat(200),
            }),
        ).toThrow(ObjectStorageError);
    });
});
