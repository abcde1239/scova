import { AVATAR_MAX_BYTES } from '@scova/models';
import { ApiError } from '@/utils/errors';

/** Bound chunked uploads too; do not trust Content-Length or buffer before authenticating. */
export async function readAvatarBody(request: Request): Promise<Uint8Array> {
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > AVATAR_MAX_BYTES))
        throw new ApiError(413, 'AVATAR_TOO_LARGE', '请选择不超过5 MiB的图片');
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError(422, 'AVATAR_INVALID', '请选择图片');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            request.signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > AVATAR_MAX_BYTES) {
                await reader.cancel();
                throw new ApiError(413, 'AVATAR_TOO_LARGE', '请选择不超过5 MiB的图片');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}
