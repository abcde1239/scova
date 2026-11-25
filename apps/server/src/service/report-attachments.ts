import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import {
    REPORT_ATTACHMENT_ACCEPT,
    REPORT_ATTACHMENT_INLINE_MAX_BYTES,
    REPORT_ATTACHMENT_MAX_PAGE_ROWS,
    REPORT_ATTACHMENT_MEDIA_TYPES,
    reportAttachmentFormat,
    type ReportAttachmentFormat,
    type ReportAttachmentMediaType,
    ReportAttachmentSchema,
    parseContract,
    type ReportAttachmentParseState,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createReportResourceRepo } from '@/repo/report-resources.ts';
import {
    parseReportText,
    validateReportImage,
    validateReportPdf,
} from '@/service/report-attachment-formats.ts';
import { parseReportCsv } from '@/service/report-csv.ts';
import { ApiError } from '@/utils/errors.ts';
import {
    attachmentObjectKey,
    attachmentStorage,
    storageRequest,
} from './report-attachment-storage.ts';

const attachmentPurpose = 'reference-csv';
// Keep the persistent purpose and parser version so legacy CSV uploads still deduplicate.
const attachmentVersion = 1;

function missing() {
    return new ApiError(404, 'NOT_FOUND', '资源不存在');
}

function safeFilename(input: string) {
    const filename = input.normalize('NFC').trim();
    const format = reportAttachmentFormat(filename);
    if (
        !format ||
        filename.length > 120 ||
        !/^[^./\\<>:"|?*][^/\\<>:"|?*]*$/u.test(filename) ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(filename)
    )
        throw new ApiError(
            422,
            'REPORT_ATTACHMENT_FILENAME',
            `请选择有效的附件文件名，支持 ${REPORT_ATTACHMENT_ACCEPT.split(',').join('、')}`,
        );
    return { filename, format };
}

async function describeAttachmentContent(
    format: ReportAttachmentFormat,
    content: Buffer,
): Promise<ReportAttachmentParseState> {
    if (format === 'pdf') {
        if (!validateReportPdf(content))
            throw new ApiError(422, 'REPORT_ATTACHMENT_INVALID_PDF', '文件结构与 PDF 格式不符');
        return { format, status: 'download_only', rowCount: null, failureCode: null };
    }
    if (format === 'png' || format === 'jpeg' || format === 'webp') {
        if (!(await validateReportImage(content, format)))
            throw new ApiError(
                422,
                'REPORT_ATTACHMENT_INVALID_IMAGE',
                '图片文件头与扩展名不符或无法读取',
            );
        return { format, status: 'download_only', rowCount: null, failureCode: null };
    }
    if (content.byteLength > REPORT_ATTACHMENT_INLINE_MAX_BYTES)
        return isUtf8(content)
            ? { format, status: 'download_only', rowCount: null, failureCode: null }
            : { format, status: 'failed', rowCount: null, failureCode: 'INVALID_UTF8' };
    const parsed = format === 'csv' ? parseReportCsv(content) : parseReportText(content, format);
    const textFormat = format === 'csv' ? {} : { format };
    return parsed.status === 'ready'
        ? { ...textFormat, status: 'ready', rowCount: parsed.rows.length, failureCode: null }
        : { ...textFormat, status: 'failed', rowCount: null, failureCode: parsed.failureCode };
}

export function createReportAttachmentService(services: ApiServices) {
    const repo = createReportResourceRepo(() => services.db());

    async function load(userId: string, reportId: string, attachmentId: string) {
        const resource = await repo.find(userId, reportId, attachmentId, attachmentPurpose);
        if (!resource) throw missing();
        if (!('filename' in resource.metadata)) throw new Error('附件资源记录无效');
        return { ...resource, metadata: resource.metadata };
    }

    async function requireOwnedReport(userId: string, reportId: string) {
        const publishedAt = await repo.publishedAt(userId, reportId);
        if (!publishedAt) throw missing();
        return publishedAt;
    }

    function describe(resource: Awaited<ReturnType<typeof repo.listAttachments>>[number]) {
        const { id, reportId, createdAt, metadata, byteLength } = resource;
        if (!('filename' in metadata)) throw new Error('附件资源记录无效');
        return parseContract(ReportAttachmentSchema, {
            id,
            reportId,
            filename: metadata.filename,
            ...(metadata.format ? { format: metadata.format } : {}),
            byteLength,
            createdAt: createdAt.toISOString(),
            status: metadata.status,
            rowCount: metadata.rowCount,
            failureCode: metadata.failureCode,
            downloadUrl: `/api/v1/reports/${reportId}/attachments/${id}/download`,
        });
    }

    return {
        async upload(
            userId: string,
            reportId: string,
            filenameInput: string,
            readBody: (mediaType: ReportAttachmentMediaType) => Promise<Buffer>,
            signal?: AbortSignal,
        ) {
            const reportVersion = await requireOwnedReport(userId, reportId);
            const { filename, format } = safeFilename(filenameInput);
            const contentType = REPORT_ATTACHMENT_MEDIA_TYPES[format];
            const content = await readBody(contentType);
            const metadata = { filename, ...(await describeAttachmentContent(format, content)) };
            const storage =
                content.byteLength > REPORT_ATTACHMENT_INLINE_MAX_BYTES
                    ? attachmentStorage(services)
                    : null;
            const objectId = storage ? randomUUID() : null;
            const createdAt = services.clock();
            if (objectId) await repo.reserveAttachmentObject(userId, objectId, createdAt);
            const result = await repo.saveAttachment(
                {
                    userId,
                    reportId,
                    reportVersion,
                    purpose: attachmentPurpose,
                    version: attachmentVersion,
                    contentKey: createHash('sha256')
                        .update(filename)
                        .update('\0')
                        .update(content)
                        .digest('hex'),
                    content: objectId ? null : content,
                    objectId,
                    objectSize: objectId ? content.byteLength : null,
                    metadata,
                    createdAt,
                },
                storage && objectId
                    ? async () => {
                          const timeout = AbortSignal.timeout(30_000);
                          await storageRequest(() =>
                              storage.upload({
                                  key: attachmentObjectKey(userId, objectId),
                                  body: content,
                                  contentType,
                                  cacheControl: 'private, no-store',
                                  signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                              }),
                          );
                      }
                    : undefined,
            );
            if (!result) throw missing();
            if (result.kind === 'quota')
                throw new ApiError(
                    409,
                    'REPORT_ATTACHMENT_QUOTA',
                    '已达到附件数量上限，请删除旧附件后重试',
                );
            return describe(result.row);
        },
        async list(userId: string, reportId: string) {
            await requireOwnedReport(userId, reportId);
            return { items: (await repo.listAttachments(userId, reportId)).map(describe) };
        },
        async rows(
            userId: string,
            reportId: string,
            attachmentId: string,
            start: number,
            end: number,
        ) {
            const resource = await load(userId, reportId, attachmentId);
            if (resource.metadata.status === 'download_only')
                throw new ApiError(409, 'REPORT_ATTACHMENT_NO_PREVIEW', '此附件可以下载原件');
            if (resource.metadata.status === 'failed')
                throw new ApiError(
                    409,
                    'REPORT_ATTACHMENT_PARSE_FAILED',
                    '附件解析失败，无法读取行文本',
                );
            if (
                !Number.isSafeInteger(start) ||
                !Number.isSafeInteger(end) ||
                start < 1 ||
                end < start ||
                end - start + 1 > REPORT_ATTACHMENT_MAX_PAGE_ROWS ||
                start > resource.metadata.rowCount
            )
                throw new ApiError(
                    422,
                    'REPORT_ATTACHMENT_ROW_RANGE',
                    '请输入有效的范围，每次最多读取 100 行',
                );
            if (!resource.content) throw new Error('附件缺少可预览内容');
            const { format } = resource.metadata;
            const parsed =
                !format || format === 'csv'
                    ? parseReportCsv(resource.content)
                    : parseReportText(resource.content, format);
            if (parsed.status !== 'ready' || parsed.rows.length !== resource.metadata.rowCount)
                throw new Error('附件解析结果与已保存资源不一致');
            return {
                attachmentId,
                rowCount: parsed.rows.length,
                rows: parsed.rows.slice(start - 1, end),
            };
        },
        async download(
            userId: string,
            reportId: string,
            attachmentId: string,
            signal: AbortSignal,
        ) {
            const resource = await load(userId, reportId, attachmentId);
            const filename = resource.metadata.filename;
            if (resource.content)
                return {
                    content: resource.content,
                    filename,
                    byteLength: resource.content.byteLength,
                };
            if (!resource.objectId || resource.objectSize === null)
                throw new Error('附件缺少存储位置');
            const storage = attachmentStorage(services);
            const key = attachmentObjectKey(userId, resource.objectId);
            const download = await storageRequest(() => storage.download(key, { signal }));
            if (download.size !== resource.objectSize) {
                await download.body.cancel().catch(() => undefined);
                throw new ApiError(
                    503,
                    'REPORT_ATTACHMENT_STORAGE_UNAVAILABLE',
                    '无法读取附件原件',
                );
            }
            return { content: download.body, filename, byteLength: resource.objectSize };
        },
        async remove(userId: string, reportId: string, attachmentId: string) {
            const removed = await repo.removeAttachment(userId, reportId, attachmentId);
            if (!removed) throw missing();
            return removed;
        },
    };
}
