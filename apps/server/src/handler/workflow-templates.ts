import type { Context } from 'elysia';
import { IdempotencyHeadersSchema, parseContract, revisionEtag } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createWorkflowTemplateService } from '@/service/workflow-templates.ts';
import { ApiError } from '@/utils/errors.ts';

type HttpContext = Pick<Context, 'request' | 'set'>;
type TemplateContext = HttpContext & { params: { templateId: string; templateVersion: string } };

export function createWorkflowTemplateHandlers(services: ApiServices) {
    const templates = createWorkflowTemplateService(services);

    async function authenticate({ request, set }: HttpContext, write = false) {
        const session = await requireSession(request, services);
        if (write) requireCsrf(request, session, services);
        set.headers['cache-control'] = 'no-store';
        return session.userId;
    }

    return {
        async list(this: void, context: HttpContext) {
            return templates.list(await authenticate(context));
        },
        async save(this: void, context: HttpContext & { body: unknown }) {
            const result = await templates.save(await authenticate(context, true), context.body);
            context.set.status = 201;
            return result;
        },
        async copy(this: void, context: TemplateContext) {
            const { templateId, templateVersion } = context.params;
            const result = await templates.copy(
                await authenticate(context, true),
                templateId,
                templateVersion,
            );
            context.set.status = 201;
            context.set.headers.location = `/api/v1/workflows/${result.workflow.id}`;
            context.set.headers.etag = revisionEtag(result.workflow.revision);
            return result;
        },
        async start(this: void, context: TemplateContext & { body: unknown }) {
            const userId = await authenticate(context, true);
            const key = context.request.headers.get('idempotency-key');
            if (!key)
                throw new ApiError(428, 'IDEMPOTENCY_REQUIRED', '启动模板必须携带 Idempotency-Key');
            parseContract(IdempotencyHeadersSchema, { 'idempotency-key': key });
            const { templateId, templateVersion } = context.params;
            const result = await templates.start(
                userId,
                templateId,
                templateVersion,
                context.body,
                key,
            );
            context.set.status = 202;
            context.set.headers.location = `/api/v1/workflow-runs/${result.run.id}`;
            return result;
        },
    };
}
