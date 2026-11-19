import { ReportExportSchema, ReportJsonExportSchema, parseContract } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createReportExportRepo } from '@/repo/report-exports.ts';
import { createReportService } from '@/service/reports.ts';
import { renderReportJson } from '@/service/report-json.ts';
import { renderReportMarkdown } from '@/service/report-markdown.ts';
import { ApiError } from '@/utils/errors.ts';

const lifetimeMs = 24 * 60 * 60 * 1000;
const rendererVersion = { markdown: 1, json: 1 };

export function createReportExportService(services: ApiServices) {
    const reports = createReportService(services);
    const repo = createReportExportRepo(() => services.db());

    async function getOrCreate(
        userId: string,
        reportId: string,
        format: keyof typeof rendererVersion,
    ) {
        const report = await reports.get(userId, reportId);
        const document =
            format === 'json' ? renderReportJson(report) : renderReportMarkdown(report);
        const createdAt = services.clock();
        const result = await repo.save({
            userId,
            reportId: report.id,
            rendererVersion: rendererVersion[format],
            format,
            content: 'markdown' in document ? document.markdown : document.content,
            byteLength: document.byteLength,
            sha256: document.sha256,
            createdAt,
            expiresAt: new Date(createdAt.getTime() + lifetimeMs),
        });
        if (result.kind === 'missing') throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        if (result.kind === 'quota')
            throw new ApiError(409, 'REPORT_EXPORT_QUOTA', '已达到暂存上限，请在旧导出过期后重试');
        const { id, content, byteLength, sha256, expiresAt } = result.row;
        return {
            id,
            reportId: report.id,
            content,
            byteLength,
            sha256,
            expiresAt: expiresAt.toISOString(),
        };
    }

    return {
        async markdown(this: void, userId: string, reportId: string) {
            const { content, ...exportMetadata } = await getOrCreate(userId, reportId, 'markdown');
            return parseContract(ReportExportSchema, {
                ...exportMetadata,
                filename: `scova-report-${exportMetadata.reportId}.md`,
                markdown: content,
            });
        },
        async json(this: void, userId: string, reportId: string) {
            const { content, ...exportMetadata } = await getOrCreate(userId, reportId, 'json');
            return parseContract(ReportJsonExportSchema, {
                ...exportMetadata,
                filename: `scova-report-${exportMetadata.reportId}.json`,
                document: JSON.parse(content),
            });
        },
    };
}
