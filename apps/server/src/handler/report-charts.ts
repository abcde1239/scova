import type { ApiServices } from '@/app/services';
import { reportResourceDownload } from '@/handler/http/report-resource-download.ts';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createReportChartService } from '@/service/report-charts.ts';

export function createReportChartHandlers(services: ApiServices) {
    const charts = createReportChartService(services);
    return {
        async generate(request: Request, reportId: string) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            return charts.generate(session.userId, reportId);
        },
        async get(request: Request, reportId: string, chartId: string) {
            const session = await requireSession(request, services);
            return charts.get(session.userId, reportId, chartId);
        },
        async download(request: Request, reportId: string, chartId: string) {
            const session = await requireSession(request, services);
            const content = await charts.download(session.userId, reportId, chartId);
            return reportResourceDownload(
                content,
                'image/svg+xml',
                `scova-source-hosts-${reportId}.svg`,
            );
        },
    };
}
