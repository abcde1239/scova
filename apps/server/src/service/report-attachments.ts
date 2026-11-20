import { createHash } from 'node:crypto';
import {
    REPORT_ATTACHMENT_MAX_PAGE_ROWS,
    ReportAttachmentSchema,
    parseContract,
    type ReportAttachmentParseState,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createReportResourceRepo } from '@/repo/report-resources.ts';
import { parseReportCsv } from '@/service/report-csv.ts';
import { ApiError } from '@/utils/errors.ts';

const attachmentPurpose = 'reference-csv';
const csvParserVersion = 1;

function missing() {
    return new ApiError(404, 'NOT_FOUND', '资源不存在');
}

function safeFilename(input: string) {
    const filename = input.normalize('NFC').trim();
    if (
        filename.length > 120 ||
        !/^[^./\\<>:"|?*][^/\\<>:"|?*]*\.csv$/iu.test(filename) ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(filename)
    )
        throw new ApiError(422, 'REPORT_ATTACHMENT_FILENAME', '请选择有效的 .csv 文件名');
    return filename;
}

export function createReportAttachmentService(services: ApiServices) {
    const repo = createReportResourceRepo(() => services.db());

    async function load(userId: string, reportId: string, attachmentId: string) {
        const resource = await repo.find(userId, reportId, attachmentId, attachmentPurpose);
        if (!resource) throw missing();
        if (!('filename' in resource.metadata)) throw new Error('CSV 资源记录无效');
        return { ...resource, metadata: resource.metadata };
    }

    async function requireOwnedReport(userId: string, reportId: string) {
        const publishedAt = await repo.publishedAt(userId, reportId);
        if (!publishedAt) throw missing();
        return publishedAt;
    }

    function describe(resource: Awaited<ReturnType<typeof repo.listAttachments>>[number]) {
        const { id, reportId, createdAt, metadata, byteLength } = resource;
        if (!('filename' in metadata)) throw new Error('CSV 资源记录无效');
        return parseContract(ReportAttachmentSchema, {
            id,
            reportId,
            filename: metadata.filename,
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
            readBody: () => Promise<Buffer>,
        ) {
            const reportVersion = await requireOwnedReport(userId, reportId);
            const filename = safeFilename(filenameInput);
            const content = await readBody();
            const parsed = parseReportCsv(content);
            const state: ReportAttachmentParseState =
                parsed.status === 'ready'
                    ? { status: 'ready', rowCount: parsed.rows.length, failureCode: null }
                    : { status: 'failed', rowCount: null, failureCode: parsed.failureCode };
            const result = await repo.saveAttachment({
                userId,
                reportId,
                reportVersion,
                purpose: attachmentPurpose,
                version: csvParserVersion,
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
            const parsed = parseReportCsv(resource.content);
            if (parsed.status !== 'ready' || parsed.rows.length !== resource.metadata.rowCount)
                throw new Error('CSV 解析结果与已保存资源不一致');
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
