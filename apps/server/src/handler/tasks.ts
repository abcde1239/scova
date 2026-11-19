import type { Context } from 'elysia';
import { parseRevisionEtag, revisionEtag } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { requireCsrf, requireSession } from '@/handler/http/session.ts';
import { createTaskService } from '@/service/tasks.ts';
import { ApiError } from '@/utils/errors.ts';

type HttpContext = Pick<Context, 'request' | 'set'>;
type TaskParams = { taskId: string };

/** HTTP 认证、头字段与状态适配；业务事务由 service 负责。 */
export function createTaskHandlers(services: ApiServices) {
    const tasks = createTaskService(services);
    const control = (action: 'pause' | 'resume' | 'archive') =>
        async function (
            this: void,
            { request, set, params }: HttpContext & { params: TaskParams },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const ifMatch = request.headers.get('if-match');
            if (!ifMatch)
                throw new ApiError(428, 'REVISION_REQUIRED', '任务控制必须携带 If-Match 修订版本');
            const result = await tasks.transition(
                session.userId,
                params.taskId,
                action,
                parseRevisionEtag(ifMatch),
            );
            set.headers.etag = revisionEtag(result.task.revision);
            return result;
        };
    return {
        async remove(this: void, { request, set, params }: HttpContext & { params: TaskParams }) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const ifMatch = request.headers.get('if-match');
            if (!ifMatch)
                throw new ApiError(428, 'REVISION_REQUIRED', '清除任务必须携带 If-Match 修订版本');
            await tasks.remove(session.userId, params.taskId, parseRevisionEtag(ifMatch));
            set.status = 204;
        },
        pause: control('pause'),
        resume: control('resume'),
        archive: control('archive'),
        async list(this: void, { request, query }: HttpContext & { query: unknown }) {
            const session = await requireSession(request, services);
            return tasks.list(session.userId, query);
        },
        async create(this: void, { request, set, body }: HttpContext & { body: unknown }) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const result = await tasks.create(session.userId, body);
            set.status = 201;
            set.headers.etag = revisionEtag(result.task.revision);
            return result;
        },
        async get(this: void, { request, set, params }: HttpContext & { params: TaskParams }) {
            const session = await requireSession(request, services);
            const result = await tasks.get(session.userId, params.taskId);
            set.headers.etag = revisionEtag(result.task.revision);
            return result;
        },
        async update(
            this: void,
            { request, set, params, body }: HttpContext & { params: TaskParams; body: unknown },
        ) {
            const session = await requireSession(request, services);
            requireCsrf(request, session, services);
            const ifMatch = request.headers.get('if-match');
            if (!ifMatch)
                throw new ApiError(428, 'REVISION_REQUIRED', '编辑任务必须携带 If-Match 修订版本');
            const expectedRevision = parseRevisionEtag(ifMatch);
            const result = await tasks.update(
                session.userId,
                params.taskId,
                body,
                expectedRevision,
            );
            set.headers.etag = revisionEtag(result.task.revision);
            return result;
        },
    };
}
