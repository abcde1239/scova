import { REPORT_ATTACHMENT_MAX_BYTES } from '@scova/models';
import { ApiError } from '@/utils/errors.ts';

function tooLarge() {
    return new ApiError(413, 'REPORT_ATTACHMENT_TOO_LARGE', 'CSV 附件不得超过 256 KiB');
}

export async function readReportAttachment(request: Request) {
    const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'text/csv')
        throw new ApiError(
            415,
            'REPORT_ATTACHMENT_MEDIA_TYPE',
            '附件的 Content-Type 必须为 text/csv',
        );
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > REPORT_ATTACHMENT_MAX_BYTES))
        throw tooLarge();
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError(422, 'REPORT_ATTACHMENT_EMPTY', '请选择非空的 CSV 文件');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const { signal } = request;
    const cancelOnAbort = () => {
        void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', cancelOnAbort, { once: true });
    try {
        while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > REPORT_ATTACHMENT_MAX_BYTES) {
                await reader.cancel().catch(() => {});
                throw tooLarge();
            }
            chunks.push(value);
        }
    } finally {
        signal.removeEventListener('abort', cancelOnAbort);
        reader.releaseLock();
    }
    if (!size) throw new ApiError(422, 'REPORT_ATTACHMENT_EMPTY', '请选择非空的 CSV 文件');
    return Buffer.concat(chunks, size);
}
