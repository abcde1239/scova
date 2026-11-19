import type { Context } from 'elysia';
import type { InboxListQuery, InboxPatchInput, ReportListQuery } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createReportService } from '@/service/reports.ts';
import { createReportExportService } from '@/service/report-exports.ts';

type HttpContext = Pick<Context, 'request' | 'set'>;

export function createReportHandlers(services: ApiServices) {
    const reports = createReportService(services);
    const exports = createReportExportService(services);
    function exportHandler<T>(load: (userId: string, reportId: string) => Promise<T>) {
        return async function (
            this: void,
            { request, set, params }: HttpContext & { params: { reportId: string } },
        ) {
            set.headers['cache-control'] = 'no-store';
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            return load(session.userId, params.reportId);
        };
    }

    return {
        async list(this: void, { request, query }: HttpContext & { query: ReportListQuery }) {
            const session = await requireSession(request, services);
            return reports.list(session.userId, query);
        },
        async get(this: void, { request, params }: HttpContext & { params: { reportId: string } }) {
            const session = await requireSession(request, services);
            return reports.get(session.userId, params.reportId);
        },
        exportMarkdown: exportHandler(exports.markdown),
        exportJson: exportHandler(exports.json),
        async inbox(this: void, { request, query }: HttpContext & { query: InboxListQuery }) {
            const session = await requireSession(request, services);
            return reports.inbox(session.userId, query);
        },
        async patchInbox(
            this: void,
            {
                request,
                params,
                body,
            }: HttpContext & { params: { inboxId: string }; body: InboxPatchInput },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            return reports.patchInbox(session.userId, params.inboxId, body);
        },
    };
}
