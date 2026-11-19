import { describe, expect, it } from 'vite-plus/test';
import { createObjectStorage } from '../src/index.ts';
import { createImageStorageView, ImageStorageError } from '../src/image/index.ts';

describe('图片适配与通用目录共享', () => {
    it('borrows an image scope with signature validation and mapped lifecycle errors', async () => {
        const root = createObjectStorage({
            provider: 'r2',
            accountId: 'a'.repeat(32),
            bucket: 'files',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        });
        try {
            const images = createImageStorageView(root.scope('avatars'));
            expect(images).not.toHaveProperty('destroy');
            const upload = await images.presignUpload({
                key: 'user/version.webp',
                contentType: 'image/webp',
                size: 100,
            });
            expect(upload.key).toBe('avatars/user/version.webp');
            await expect(images.upload({ body: Buffer.from('%PDF-1.7') })).rejects.toMatchObject({
                code: 'invalid_image',
            });
            await expect(images.presignDownload('reports/result.pdf')).rejects.toBeInstanceOf(
                ImageStorageError,
            );
            root.destroy();
            await expect(images.presignDownload(upload.key)).rejects.toMatchObject({
                code: 'storage_closed',
            });
        } finally {
            root.destroy();
        }
    });
});
