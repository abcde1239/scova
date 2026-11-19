import { randomUUID } from 'node:crypto';
import { createStorageKey } from '@scova/object-storage';
import sharp from 'sharp';
import { AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES } from '@scova/models';
import type { ImageStorageClient } from '@scova/object-storage/image';
import type { ApiServices } from '@/app/services';
import type { AuthenticatedSession } from '@/service/auth';
import { createAvatarRepository } from '@/repo/avatar';
import { ApiError } from '@/utils/errors';

export const avatarKey = (userId: string, version: string) =>
    createStorageKey({ purpose: 'avatars', ownerId: userId, objectId: version, extension: 'webp' });

export async function normalizeAvatar(body: Uint8Array, contentType: string): Promise<Uint8Array> {
    if (!body.byteLength || body.byteLength > AVATAR_MAX_BYTES)
        throw new ApiError(413, 'AVATAR_TOO_LARGE', '请选择不超过5 MiB的图片');
    if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(contentType))
        throw new ApiError(415, 'AVATAR_TYPE_UNSUPPORTED', '请选择JPEG、PNG、GIF或WebP图片');
    try {
        const image = sharp(body, { limitInputPixels: 16_000_000, failOn: 'warning', pages: 1 });
        const metadata = await image.metadata();
        const expected = {
            'image/jpeg': 'jpeg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
        };
        if (metadata.format !== expected[contentType as keyof typeof expected]) throw new Error();
        // Decode/rotate/crop/re-encode; default sharp output strips EXIF and embedded metadata.
        return await image
            .rotate()
            .resize(256, 256, { fit: 'cover' })
            .webp({ quality: 85 })
            .toBuffer();
    } catch {
        throw new ApiError(422, 'AVATAR_INVALID', '图片无法读取，请重新选择完整的图片');
    }
}

export function createAvatarService(services: ApiServices) {
    const repository = createAvatarRepository(services);
    const limitWrite = async (userId: string) => {
        let counts: unknown;
        try {
            counts = await repository.takeWriteSlot(userId);
        } catch {
            throw new ApiError(503, 'AVATAR_UNAVAILABLE', '头像服务暂时不可用');
        }
        if (!Array.isArray(counts) || counts.length !== 2)
            throw new ApiError(503, 'AVATAR_UNAVAILABLE', '头像服务暂时不可用');
        if (Number(counts[0]) > 10 || Number(counts[1]) > 100) {
            const error = new ApiError(429, 'RATE_LIMITED', '头像操作过于频繁，请稍后重试');
            error.retryAfterSeconds = 60;
            throw error;
        }
    };
    const storage = () => {
        try {
            return services.avatarStorage();
        } catch {
            throw new ApiError(503, 'AVATAR_UNAVAILABLE', '头像存储暂时不可用');
        }
    };
    const requiredStorage = () => {
        const images = storage();
        if (!images) throw new ApiError(503, 'AVATAR_UNAVAILABLE', '当前部署尚未启用头像上传');
        return images;
    };
    const cleanup = async (
        images: ImageStorageClient | null,
        userId: string,
        version: string | null,
    ) => {
        if (!images || !version) return;
        try {
            await images.delete(avatarKey(userId, version), { signal: AbortSignal.timeout(5_000) });
        } catch {
            /* DB is authoritative; reconciliation must compare references before cleanup. */
        }
    };
    const assertVersion = (session: AuthenticatedSession, expected: string | null) => {
        if ((session.user.avatarVersion ?? null) !== expected)
            throw new ApiError(409, 'AVATAR_CHANGED', '头像已在其他页面更新，请刷新后重试');
    };
    return {
        state(session: AuthenticatedSession) {
            return { available: storage() !== null, version: session.user.avatarVersion ?? null };
        },
        async upload(
            session: AuthenticatedSession,
            expected: string | null,
            body: Uint8Array,
            contentType: string,
            signal?: AbortSignal,
        ) {
            assertVersion(session, expected);
            const images = requiredStorage();
            await limitWrite(session.userId);
            const bytes = await normalizeAvatar(body, contentType);
            signal?.throwIfAborted();
            const version = randomUUID();
            try {
                await images.upload({
                    body: bytes,
                    contentType: 'image/webp',
                    key: avatarKey(session.userId, version),
                    cacheControl: 'private, max-age=300',
                    signal: AbortSignal.any([
                        AbortSignal.timeout(30_000),
                        ...(signal ? [signal] : []),
                    ]),
                });
            } catch {
                throw new ApiError(503, 'AVATAR_UPLOAD_FAILED', '头像未保存，请稍后重试');
            }
            // On ambiguous DB/network failure retain the candidate; deleting it could break a committed row.
            const user = await repository.replace(session.userId, expected, version);
            if (!user) {
                await cleanup(images, session.userId, version);
                throw new ApiError(409, 'AVATAR_CHANGED', '头像已在其他页面更新，请刷新后重试');
            }
            await cleanup(images, session.userId, expected);
            return user;
        },
        async remove(session: AuthenticatedSession, expected: string | null) {
            assertVersion(session, expected);
            await limitWrite(session.userId);
            const user = await repository.replace(session.userId, expected, null);
            if (!user)
                throw new ApiError(409, 'AVATAR_CHANGED', '头像已在其他页面更新，请刷新后重试');
            let images: ImageStorageClient | null = null;
            try {
                images = storage();
            } catch {
                /* Removing an avatar remains possible without storage. */
            }
            await cleanup(images, session.userId, expected);
            return user;
        },
        async location(session: AuthenticatedSession, version: string) {
            if (session.user.avatarVersion !== version)
                throw new ApiError(404, 'NOT_FOUND', '头像不存在');
            try {
                return await requiredStorage().presignDownload(avatarKey(session.userId, version), {
                    expiresIn: 300,
                });
            } catch {
                throw new ApiError(503, 'AVATAR_UNAVAILABLE', '头像暂时无法读取');
            }
        },
    };
}
