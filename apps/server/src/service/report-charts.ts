import { ReportSourceHostChartSchema, parseContract } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createReportResourceRepo } from '@/repo/report-resources.ts';
import { renderSourceHostChart, reportSourceHostRows } from '@/service/report-source-host-chart.ts';
import { createReportService } from '@/service/reports.ts';
import { ApiError } from '@/utils/errors.ts';

const chartPurpose = 'source-host-chart';
const chartRendererVersion = 1;
const downloadLifetimeMs = 24 * 60 * 60 * 1000;

export function createReportChartService(services: ApiServices) {
    const reports = createReportService(services);
    const repo = createReportResourceRepo(() => services.db());

    async function load(userId: string, reportId: string, chartId: string) {
        const resource = await repo.find(userId, reportId, chartId, chartPurpose);
        if (!resource) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        return resource;
    }

    function describe(resource: Awaited<ReturnType<typeof load>>) {
        if (!resource.expiresAt || !('rows' in resource.metadata))
            throw new Error('图表资源记录无效');
        return parseContract(ReportSourceHostChartSchema, {
            id: resource.id,
            reportId: resource.reportId,
            reportVersion: resource.reportVersion.toISOString(),
            rendererVersion: resource.version,
            expiresAt: resource.expiresAt.toISOString(),
            downloadUrl: `/api/v1/reports/${resource.reportId}/charts/${resource.id}/download`,
            rows: resource.metadata.rows,
        });
    }

    return {
        async generate(userId: string, reportId: string) {
            const report = await reports.get(userId, reportId);
            const rows = reportSourceHostRows(report);
            const { content, contentKey } = renderSourceHostChart(rows);
            const now = services.clock();
            const resource = await repo.saveChart(
                {
                    userId,
                    reportId: report.id,
                    reportVersion: new Date(report.publishedAt),
                    purpose: chartPurpose,
                    version: chartRendererVersion,
                    contentKey,
                    content,
                    metadata: { rows },
                    createdAt: now,
                    expiresAt: new Date(now.getTime() + downloadLifetimeMs),
                },
                now,
            );
            if (!resource) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
            return describe(resource);
        },
        async get(userId: string, reportId: string, chartId: string) {
            return describe(await load(userId, reportId, chartId));
        },
        async download(userId: string, reportId: string, chartId: string) {
            const resource = await load(userId, reportId, chartId);
            if (!resource.expiresAt || resource.expiresAt <= services.clock())
                throw new ApiError(410, 'REPORT_CHART_EXPIRED', '图表下载已过期，请重新生成');
            if (!resource.content) throw new Error('图表资源缺少内联内容');
            return resource.content;
        },
    };
}
