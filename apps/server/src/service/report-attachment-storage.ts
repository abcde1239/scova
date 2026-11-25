import type { ObjectStorage } from '@scova/object-storage';
import type { ApiServices } from '@/app/services';
import { createReportResourceRepo } from '@/repo/report-resources.ts';
import { ApiError } from '@/utils/errors.ts';

const abandonedObjectGraceMs = 60 * 60 * 1000;
const storageUnavailable = () =>
    new ApiError(503, 'REPORT_ATTACHMENT_STORAGE_UNAVAILABLE', '附件对象存储暂时不可用');

export function attachmentObjectKey(userId: string, id: string) {
    return `report-attachments/${userId}/${id}`;
}

export function attachmentStorage(services: Pick<ApiServices, 'objectStorage'>): ObjectStorage {
    let storage: ObjectStorage | null;
    try {
        storage = services.objectStorage();
    } catch {
        throw storageUnavailable();
    }
    if (!storage)
        throw new ApiError(
            503,
            'REPORT_ATTACHMENT_STORAGE_DISABLED',
            '此部署尚未配置大附件对象存储',
        );
    return storage;
}

export async function storageRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
        return await request();
    } catch {
        throw storageUnavailable();
    }
}

export async function cleanUnusedReportAttachments(
    services: Pick<ApiServices, 'objectStorage' | 'clock'>,
    repo: ReturnType<typeof createReportResourceRepo>,
    limit: number,
    signal: AbortSignal,
) {
    const storage = services.objectStorage();
    if (!storage) return;
    const cutoff = new Date(services.clock().getTime() - abandonedObjectGraceMs);
    for (const { userId, id } of await repo.findUnusedAttachmentObjects(cutoff, limit)) {
        signal.throwIfAborted();
        await repo.removeUnusedAttachmentObject(userId, id, () =>
            storage.delete(attachmentObjectKey(userId, id), {
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            }),
        );
    }
}
