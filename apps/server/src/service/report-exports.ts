import { ReportExportSchema, parseContract } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createReportExportRepo } from '@/repo/report-exports.ts';
import { createReportService } from '@/service/reports.ts';
import { renderReportMarkdown } from '@/service/report-markdown.ts';
import { ApiError } from '@/utils/errors.ts';

const lifetimeMs = 24 * 60 * 60 * 1000;
const rendererVersion = 1;

export function createReportExportService(services: ApiServices) {
    const reports = createReportService(services);
    const repo = createReportExportRepo(() => services.db());
    return {
        async getOrCreate(userId: string, reportId: string) {
            const report = await reports.get(userId, reportId);
            const document = renderReportMarkdown(report);
            const createdAt = services.clock();
            const result = await repo.save({
                userId,
                reportId: report.id,
                rendererVersion,
                ...document,
                createdAt,
                expiresAt: new Date(createdAt.getTime() + lifetimeMs),
            });
            if (result.kind === 'missing') throw new ApiError(404, 'NOT_FOUND', '资源不存在');
            if (result.kind === 'quota')
                throw new ApiError(
                    409,
                    'REPORT_EXPORT_QUOTA',
                    '已达到暂存上限，请在旧导出过期后重试',
                );
            const { id, markdown, byteLength, sha256, expiresAt } = result.row;
            return parseContract(ReportExportSchema, {
                id,
                reportId: report.id,
                filename: `scova-report-${report.id}.md`,
                markdown,
                byteLength,
                sha256,
                expiresAt: expiresAt.toISOString(),
            });
        },
    };
}
