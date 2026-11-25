import { PROJECT_THREAD_ATTACHMENT_MAX_BYTES } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { readReportAttachment } from '@/handler/http/report-attachment-body.ts';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createThreadAttachmentService } from '@/service/thread-attachments.ts';

export function createThreadAttachmentHandlers(services: ApiServices) {
    const attachments = createThreadAttachmentService(services);
    return {
        async upload(request: Request, threadId: string, filename: string) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            return attachments.upload(
                session.userId,
                threadId,
                filename,
                (mediaType) =>
                    readReportAttachment(request, mediaType, PROJECT_THREAD_ATTACHMENT_MAX_BYTES),
                request.signal,
            );
        },
        async metadata(request: Request, threadId: string, attachmentId: string) {
            const session = await requireSession(request, services);
            return attachments.metadata(session.userId, threadId, attachmentId);
        },
        async download(request: Request, threadId: string, attachmentId: string) {
            const session = await requireSession(request, services);
            const { body, filename, byteLength } = await attachments.download(
                session.userId,
                threadId,
                attachmentId,
                request.signal,
            );
            const encoded = encodeURIComponent(filename).replace(
                /[!'()*]/g,
                (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
            );
            return new Response(body, {
                headers: {
                    'content-type': 'application/octet-stream',
                    'content-disposition': `attachment; filename*=UTF-8''${encoded}`,
                    'content-length': String(byteLength),
                    'cache-control': 'private, no-store',
                    'content-security-policy': "default-src 'none'; sandbox",
                    'x-content-type-options': 'nosniff',
                },
            });
        },
    };
}
