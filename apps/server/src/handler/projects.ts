import type { Context } from 'elysia';
import { CreateProjectTaskInputSchema, parseContract } from '@scova/models';
import { createProjectConversationService } from '@/service/project-conversations.ts';
import { createTaskService } from '@/service/tasks.ts';
import { ApiError } from '@/utils/errors.ts';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createProjectService } from '@/service/projects';

type HttpContext = Pick<Context, 'request' | 'set'>;
type ProjectParams = { projectId: string };
type TaskMembershipParams = ProjectParams & { taskId: string };

export function createProjectHandlers(services: ApiServices) {
    const projects = createProjectService(services);
    const tasks = createTaskService(services);
    const conversation = createProjectConversationService(services);
    async function authenticate({ request, set }: HttpContext) {
        const session = await requireSession(request, services);
        set.headers['cache-control'] = 'no-store';
        return session;
    }
    const membership = (associate: boolean) =>
        async function (this: void, context: HttpContext & { params: TaskMembershipParams }) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            const { projectId, taskId } = context.params;
            await projects.setMembership(session.userId, projectId, taskId, associate);
            context.set.status = 204;
        };
    return {
        async list(this: void, context: HttpContext & { query: unknown }) {
            const session = await authenticate(context);
            return projects.list(session.userId, context.query);
        },
        async create(this: void, context: HttpContext & { body: unknown }) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            const project = await projects.create(session.userId, context.body);
            context.set.status = 201;
            return project;
        },
        async createTask(
            this: void,
            context: HttpContext & { params: ProjectParams; body: unknown },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            const key = context.request.headers.get('idempotency-key');
            if (!key)
                throw new ApiError(
                    428,
                    'IDEMPOTENCY_REQUIRED',
                    '创建项目任务必须携带 Idempotency-Key',
                );
            const { start, ...input } = parseContract(CreateProjectTaskInputSchema, context.body);
            const result = await tasks.createInProject(
                session.userId,
                context.params.projectId,
                input,
                key,
                start,
            );
            context.set.status = 201;
            return result;
        },
        async detail(this: void, context: HttpContext & { params: ProjectParams; query: unknown }) {
            const session = await authenticate(context);
            return projects.detail(session.userId, context.params.projectId, context.query);
        },
        async remove(this: void, context: HttpContext & { params: ProjectParams }) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            await projects.remove(session.userId, context.params.projectId);
            context.set.status = 204;
        },
        async conversation(this: void, context: HttpContext & { params: ProjectParams }) {
            const session = await authenticate(context);
            return conversation.get(session.userId, context.params.projectId);
        },
        async sendTurn(
            this: void,
            context: HttpContext & { params: ProjectParams; body: unknown },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return conversation.send(session, context.params.projectId, context.body);
        },
        async cancelTurn(
            this: void,
            context: HttpContext & { params: ProjectParams & { turnId: string } },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return conversation.cancel(
                session.userId,
                context.params.projectId,
                context.params.turnId,
            );
        },
        async editDraft(
            this: void,
            context: HttpContext & { params: ProjectParams & { draftId: string }; body: unknown },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return conversation.edit(
                session.userId,
                context.params.projectId,
                context.params.draftId,
                context.body,
            );
        },
        async confirmDraft(
            this: void,
            context: HttpContext & { params: ProjectParams & { draftId: string }; body: unknown },
        ) {
            const session = await authenticate(context);
            requireCsrf(context.request, session, services);
            return conversation.confirm(
                session.userId,
                context.params.projectId,
                context.params.draftId,
                context.body,
            );
        },
        associate: membership(true),
        unlink: membership(false),
    };
}
