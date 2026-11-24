import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseExecutor, ProjectThreadAttachmentRow } from '@scova/db';
import {
    PROJECT_THREAD_ATTACHMENT_EXCERPT_CHARS,
    REPORT_ATTACHMENT_MEDIA_TYPES,
    reportAttachmentFormat,
    type ProjectThreadAttachment,
    type ReportAttachmentMediaType,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectThreadStore } from '@/repo/project-threads.ts';
import { createThreadAttachmentRepo } from '@/repo/thread-attachments.ts';
import { parseReportText, validateReportPdf } from '@/service/report-attachment-formats.ts';
import { parseReportCsv } from '@/service/report-csv.ts';
import { requireWritableThread, threadMissing } from '@/service/thread-actions.ts';
import { ApiError } from '@/utils/errors.ts';

const abandonedAfterMs = 15 * 60_000;
const transferTimeoutMs = 15_000;
const excerptSegmenter = new Intl.Segmenter();

function unavailable() {
    return new ApiError(503, 'THREAD_ATTACHMENT_UNAVAILABLE', '会话附件存储暂时不可用，请稍后重试');
}

function requireStorage(services: ApiServices) {
    try {
        const storage = services.objectStorage();
        if (storage) return storage;
    } catch {
        // Keep provider configuration and request details private.
    }
    throw unavailable();
}

function filenameAndFormat(input: string) {
    const filename = input.normalize('NFC').trim();
    const format = reportAttachmentFormat(filename);
    if (
        !format ||
        filename.length > 120 ||
        !/^[^./\\<>:"|?*][^/\\<>:"|?*]*\.(?:csv|txt|pdf)$/iu.test(filename) ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(filename)
    )
        throw new ApiError(
            422,
            'THREAD_ATTACHMENT_FILENAME',
            '请选择有效的 CSV、TXT 或 PDF 文件名',
        );
    return { filename, format };
}

function extractExcerpt(format: ProjectThreadAttachment['format'], content: Buffer) {
    const invalid = () =>
        new ApiError(
            422,
            'THREAD_ATTACHMENT_INVALID_CONTENT',
            '附件内容与文件格式不符或超出解析限制',
        );
    if (format === 'pdf') {
        if (!validateReportPdf(content)) throw invalid();
        return null;
    }
    const parsed = format === 'csv' ? parseReportCsv(content) : parseReportText(content);
    if (parsed.status !== 'ready') throw invalid();
    const text = new TextDecoder('utf-8').decode(content).trim();
    let remaining = PROJECT_THREAD_ATTACHMENT_EXCERPT_CHARS;
    for (const { index, segment } of excerptSegmenter.segment(text)) {
        remaining -= Array.from(segment).length;
        if (remaining < 0) return text.slice(0, index) || null;
    }
    return text || null;
}

function describe(row: ProjectThreadAttachmentRow, threadId: string): ProjectThreadAttachment {
    if (!row.readyAt) throw new Error('附件尚未就绪');
    return {
        id: row.id,
        threadId,
        filename: row.filename,
        format: row.format,
        byteLength: row.byteLength,
        textAvailable: row.excerpt !== null,
        createdAt: row.readyAt.toISOString(),
    };
}

async function requireOwnedAttachment(
    db: DatabaseExecutor,
    userId: string,
    threadId: string,
    id: string,
) {
    const [row] = await createThreadAttachmentRepo(db).findReady(userId, threadId, [id]);
    if (!row) throw threadMissing();
    return row;
}

export async function resolveThreadAttachmentContext(
    db: DatabaseExecutor,
    userId: string,
    threadId: string,
    ids: readonly string[],
) {
    const uniqueIds = [...new Set(ids)];
    const rows = await createThreadAttachmentRepo(db).findReady(userId, threadId, uniqueIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return uniqueIds.map((id) => {
        const row = byId.get(id);
        if (!row) throw threadMissing();
        return { id, filename: row.filename, excerpt: row.excerpt };
    });
}

function exactLength(byteLength: number) {
    let seen = 0;
    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            seen += chunk.byteLength;
            if (seen > byteLength) throw unavailable();
            controller.enqueue(chunk);
        },
        flush() {
            if (seen !== byteLength) throw unavailable();
        },
    });
}

export function createThreadAttachmentService(
    services: ApiServices,
    fetcher: typeof fetch = fetch,
) {
    return {
        async upload(
            userId: string,
            threadId: string,
            filenameInput: string,
            readBody: (mediaType: ReportAttachmentMediaType) => Promise<Buffer>,
            requestSignal: AbortSignal,
        ) {
            const db = services.db();
            const thread = await createProjectThreadStore(db, userId).find(threadId);
            if (!thread) throw threadMissing();
            requireWritableThread(thread);
            const { filename, format } = filenameAndFormat(filenameInput);
            const storage = requireStorage(services);
            const mediaType = REPORT_ATTACHMENT_MEDIA_TYPES[format];
            const content = await readBody(mediaType);
            const excerpt = extractExcerpt(format, content);
            const digest = createHash('sha256')
                .update(filename)
                .update('\0')
                .update(content)
                .digest('hex');
            const id = randomUUID();
            const keyForId = (value: string) => `thread-attachments/${value}`;
            let storageKey: string;
            try {
                // Only the key is retained. This keeps the configured bucket prefix for cleanup.
                ({ key: storageKey } = await storage.presignUpload({
                    key: keyForId(id),
                    contentType: mediaType,
                    size: content.byteLength,
                }));
            } catch {
                throw unavailable();
            }
            requestSignal.throwIfAborted();
            const reserved = await db.transaction(async (tx) => {
                const current = await createProjectThreadStore(tx, userId).lock(threadId);
                if (!current) throw threadMissing();
                requireWritableThread(current);
                return createThreadAttachmentRepo(tx).reserve({
                    id,
                    threadId,
                    filename,
                    format,
                    digest,
                    storageKey,
                    excerpt,
                    byteLength: content.byteLength,
                    updatedAt: services.clock(),
                });
            });
            if (reserved.readyAt) return describe(reserved, threadId);
            return db.transaction(async (tx) => {
                const repo = createThreadAttachmentRepo(tx);
                // The same row lock serializes retries with cleanup. Other attachments use separate locks.
                const current = await repo.lock(reserved.id, threadId);
                if (!current) throw threadMissing();
                if (current.readyAt) return describe(current, threadId);
                try {
                    await storage.upload({
                        key: keyForId(current.id),
                        body: content,
                        contentType: mediaType,
                        cacheControl: 'private, no-store',
                        signal: AbortSignal.any([
                            requestSignal,
                            AbortSignal.timeout(transferTimeoutMs),
                        ]),
                    });
                } catch {
                    // A timed out PUT may have succeeded. Retain the reservation for retry or cleanup.
                    throw unavailable();
                }
                return describe(await repo.markReady(current.id, services.clock()), threadId);
            });
        },
        async metadata(userId: string, threadId: string, attachmentId: string) {
            return describe(
                await requireOwnedAttachment(services.db(), userId, threadId, attachmentId),
                threadId,
            );
        },
        async download(
            userId: string,
            threadId: string,
            attachmentId: string,
            requestSignal: AbortSignal,
        ) {
            const row = await requireOwnedAttachment(services.db(), userId, threadId, attachmentId);
            const storage = requireStorage(services);
            try {
                const url = await storage.presignDownload(row.storageKey, { expiresIn: 60 });
                const response = await fetcher(url, {
                    redirect: 'error',
                    signal: AbortSignal.any([
                        requestSignal,
                        AbortSignal.timeout(transferTimeoutMs),
                    ]),
                });
                const length = response.headers.get('content-length');
                if (
                    response.status !== 200 ||
                    !response.body ||
                    (length !== null && length !== String(row.byteLength))
                ) {
                    await response.body?.cancel();
                    throw unavailable();
                }
                return {
                    filename: row.filename,
                    byteLength: row.byteLength,
                    body: response.body.pipeThrough(exactLength(row.byteLength)),
                };
            } catch {
                throw unavailable();
            }
        },
    };
}

export async function cleanThreadAttachments(
    services: Pick<ApiServices, 'db' | 'objectStorage' | 'clock'>,
    signal?: AbortSignal,
) {
    const storage = services.objectStorage();
    if (!storage || signal?.aborted) return;
    const db = services.db();
    const cutoff = new Date(services.clock().getTime() - abandonedAfterMs);
    const candidates = await createThreadAttachmentRepo(db).candidates(cutoff, 8);
    for (const { id } of candidates) {
        if (signal?.aborted) return;
        await db.transaction(async (tx) => {
            const repo = createThreadAttachmentRepo(tx);
            const row = await repo.lockCandidate(id, cutoff);
            if (!row) return;
            try {
                await storage.delete(row.storageKey, {
                    signal: AbortSignal.any([
                        AbortSignal.timeout(5_000),
                        ...(signal ? [signal] : []),
                    ]),
                });
            } catch {
                await repo.postponeCleanup(id, services.clock());
                return;
            }
            await repo.remove(id);
        });
    }
}
