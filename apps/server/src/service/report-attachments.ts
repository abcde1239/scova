import { createHash } from 'node:crypto';
import {
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
import { parseReportText, validateReportPdf } from '@/service/report-attachment-formats.ts';
import { parseReportCsv } from '@/service/report-csv.ts';
import { ApiError } from '@/utils/errors.ts';

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
        !/^[^./\\<>:"|?*][^/\\<>:"|?*]*\.(?:csv|txt|pdf)$/iu.test(filename) ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(filename)
    )
        throw new ApiError(
            422,
            'REPORT_ATTACHMENT_FILENAME',
            '请选择有效的 .csv、.txt 或 .pdf 文件名',
        );
    return { filename, format };
}

function describeAttachmentContent(
    format: ReportAttachmentFormat,
    content: Buffer,
): ReportAttachmentParseState {
    if (format === 'pdf') {
        if (!validateReportPdf(content))
            throw new ApiError(422, 'REPORT_ATTACHMENT_INVALID_PDF', '文件结构与 PDF 格式不符');
        return { format, status: 'download_only', rowCount: null, failureCode: null };
    }
    const parsed = format === 'txt' ? parseReportText(content) : parseReportCsv(content);
    const textFormat = format === 'txt' ? { format } : {};
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
        ) {
            const reportVersion = await requireOwnedReport(userId, reportId);
            const { filename, format } = safeFilename(filenameInput);
            const content = await readBody(REPORT_ATTACHMENT_MEDIA_TYPES[format]);
            const state = describeAttachmentContent(format, content);
            const result = await repo.saveAttachment({
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
                content,
                metadata: { filename, ...state },
                createdAt: services.clock(),
            });
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
                throw new ApiError(409, 'REPORT_ATTACHMENT_NO_PREVIEW', 'PDF 附件可以下载原件');
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
            const parseRows = resource.metadata.format === 'txt' ? parseReportText : parseReportCsv;
            const parsed = parseRows(resource.content);
            if (parsed.status !== 'ready' || parsed.rows.length !== resource.metadata.rowCount)
                throw new Error('附件解析结果与已保存资源不一致');
            return {
                attachmentId,
                rowCount: parsed.rows.length,
                rows: parsed.rows.slice(start - 1, end),
            };
        },
        async download(userId: string, reportId: string, attachmentId: string) {
            const resource = await load(userId, reportId, attachmentId);
            return { content: resource.content, filename: resource.metadata.filename };
        },
        async remove(userId: string, reportId: string, attachmentId: string) {
            const removed = await repo.removeAttachment(userId, reportId, attachmentId);
            if (!removed) throw missing();
            return removed;
        },
    };
}
