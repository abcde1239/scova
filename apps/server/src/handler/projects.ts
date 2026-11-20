import type { Context } from 'elysia';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createProjectService } from '@/service/projects';

type HttpContext = Pick<Context, 'request' | 'set'>;
type ProjectParams = { projectId: string };
type TaskMembershipParams = ProjectParams & { taskId: string };

export function createProjectHandlers(services: ApiServices) {
    const projects = createProjectService(services);
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
        associate: membership(true),
        unlink: membership(false),
    };
}
