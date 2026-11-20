import type { ApiServices } from '@/app/services';
import { readReportAttachment } from '@/handler/http/report-attachment-body.ts';
import { reportResourceDownload } from '@/handler/http/report-resource-download.ts';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createReportAttachmentService } from '@/service/report-attachments.ts';

export function createReportAttachmentHandlers(services: ApiServices) {
    const attachments = createReportAttachmentService(services);
    return {
        async upload(request: Request, reportId: string, filename: string) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            return attachments.upload(session.userId, reportId, filename, () =>
                readReportAttachment(request),
            );
        },
        async list(request: Request, reportId: string) {
            const session = await requireSession(request, services);
            return attachments.list(session.userId, reportId);
        },
        async rows(
            request: Request,
            reportId: string,
            attachmentId: string,
            start: number,
            end: number,
        ) {
            const session = await requireSession(request, services);
            return attachments.rows(session.userId, reportId, attachmentId, start, end);
        },
        async download(request: Request, reportId: string, attachmentId: string) {
            const session = await requireSession(request, services);
            const { content, filename } = await attachments.download(
                session.userId,
                reportId,
                attachmentId,
            );
            return reportResourceDownload(content, 'application/octet-stream', filename);
        },
        async remove(request: Request, reportId: string, attachmentId: string) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            return attachments.remove(session.userId, reportId, attachmentId);
        },
    };
}
