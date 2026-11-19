import { describe, expect, it } from 'vite-plus/test';
import sharp from 'sharp';
import { AVATAR_MAX_BYTES } from '@scova/models';
import { normalizeAvatar } from '../src/service/avatar';
import { readAvatarBody } from '../src/handler/http/avatar-body';
import { createAvatarStorage } from '../src/app/avatar-storage';

describe('头像输入边界', () => {
    it('逐块限制实际字节数，不信任缺省Content-Length', async () => {
        let cancelled = false;
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(AVATAR_MAX_BYTES));
                controller.enqueue(new Uint8Array(1));
            },
            cancel() {
                cancelled = true;
            },
        });
        const request = new Request('http://localhost/avatar', {
            method: 'PUT',
            body: stream,
            duplex: 'half',
        } as RequestInit);
        await expect(readAvatarBody(request)).rejects.toMatchObject({ status: 413 });
        expect(cancelled).toBe(true);
    });
    it('拒绝超过解码像素上限的压缩图片', async () => {
        const huge = await sharp({
            create: { width: 4001, height: 4000, channels: 3, background: 'white' },
        })
            .png()
            .toBuffer();
        await expect(normalizeAvatar(huge, 'image/png')).rejects.toMatchObject({ status: 422 });
    });
    it('未配置图床默认关闭；无效配置只暴露变量名', () => {
        expect(createAvatarStorage({})).toBeNull();
        expect(() => createAvatarStorage({ IMAGE_STORAGE_PROVIDER: 'r2' })).toThrow(
            'IMAGE_STORAGE_BUCKET',
        );
        expect(() =>
            createAvatarStorage({
                IMAGE_STORAGE_PROVIDER: 'other',
                IMAGE_STORAGE_BUCKET: 'images',
                IMAGE_STORAGE_ACCESS_KEY_ID: 'fake',
                IMAGE_STORAGE_SECRET_ACCESS_KEY: 'fake',
            }),
        ).toThrow('provider');
    });
});
