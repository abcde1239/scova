import type { Context } from 'elysia';
import {
    IdempotencyHeadersSchema,
    parseContract,
    parseRevisionEtag,
    revisionEtag,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createWorkflowService } from '@/service/workflows.ts';
import { ApiError } from '@/utils/errors.ts';

type HttpContext = Pick<Context, 'request' | 'set'>;
type WithParams<Params> = HttpContext & { params: Params };
type WorkflowParams = { workflowId: string };
type RunParams = { runId: string };

function revision(request: Request) {
    const value = request.headers.get('if-match');
    if (!value) throw new ApiError(428, 'REVISION_REQUIRED', '工作流命令必须携带 If-Match');
    return parseRevisionEtag(value);
}

export function createWorkflowHandlers(services: ApiServices) {
    const workflows = createWorkflowService(services);
    async function authenticate({ request, set }: HttpContext, write = false) {
        const session = await requireSession(request, services);
        if (write) requireCsrf(request, session, services);
        set.headers['cache-control'] = 'no-store';
        return session.userId;
    }
    return {
        async list(this: void, context: HttpContext & { query: unknown }) {
            return workflows.list(await authenticate(context), context.query);
        },
        async create(this: void, context: HttpContext & { body: unknown }) {
            const result = await workflows.create(await authenticate(context, true), context.body);
            context.set.status = 201;
            context.set.headers.location = `/api/v1/workflows/${result.workflow.id}`;
            context.set.headers.etag = revisionEtag(result.workflow.revision);
            return result;
        },
        async get(this: void, context: WithParams<WorkflowParams>) {
            const result = await workflows.get(
                await authenticate(context),
                context.params.workflowId,
            );
            context.set.headers.etag = revisionEtag(result.workflow.revision);
            return result;
        },
        async listVersions(this: void, context: WithParams<WorkflowParams> & { query: unknown }) {
            return workflows.listVersions(
                await authenticate(context),
                context.params.workflowId,
                context.query,
            );
        },
        async version(this: void, context: WithParams<WorkflowParams & { versionId: string }>) {
            return workflows.getVersion(
                await authenticate(context),
                context.params.workflowId,
                context.params.versionId,
            );
        },
        async updateDraft(this: void, context: WithParams<WorkflowParams> & { body: unknown }) {
            const result = await workflows.updateDraft(
                await authenticate(context, true),
                context.params.workflowId,
                context.body,
                revision(context.request),
            );
            context.set.headers.etag = revisionEtag(result.workflow.revision);
            return result;
        },
        async publish(this: void, context: WithParams<WorkflowParams>) {
            const result = await workflows.publish(
                await authenticate(context, true),
                context.params.workflowId,
                revision(context.request),
            );
            context.set.headers.etag = revisionEtag(result.workflow.revision);
            return result;
        },
        async listRuns(this: void, context: WithParams<WorkflowParams> & { query: unknown }) {
            return workflows.listRuns(
                await authenticate(context),
                context.params.workflowId,
                context.query,
            );
        },
        async start(this: void, context: WithParams<WorkflowParams> & { body: unknown }) {
            const userId = await authenticate(context, true);
            const key = context.request.headers.get('idempotency-key');
            if (!key)
                throw new ApiError(
                    428,
                    'IDEMPOTENCY_REQUIRED',
                    '启动工作流必须携带 Idempotency-Key',
                );
            parseContract(IdempotencyHeadersSchema, { 'idempotency-key': key });
            const result = await workflows.start(
                userId,
                context.params.workflowId,
                context.body,
                key,
            );
            context.set.status = 202;
            context.set.headers.location = `/api/v1/workflow-runs/${result.run.id}`;
            return result;
        },
        async getRun(this: void, context: WithParams<RunParams>) {
            return workflows.getRun(await authenticate(context), context.params.runId);
        },
        async cancel(this: void, context: WithParams<RunParams>) {
            return workflows.cancel(await authenticate(context, true), context.params.runId);
        },
    };
}
