import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    CreateProjectInputSchema,
    PageQuerySchema,
    ProjectDetailResponseSchema,
    ProjectListResponseSchema,
    ProjectSchema,
    UuidSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectHandlers } from '@/handler/projects';

const PageQuery = t.Object(
    {
        ...PageQuerySchema.properties,
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false, description: PageQuerySchema.description },
);
const ProjectParams = t.Object({ projectId: UuidSchema });
const MembershipParams = t.Object({ projectId: UuidSchema, taskId: UuidSchema });
const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    422: ApiErrorSchema,
} as const;

export function createProjectPlugin(services: ApiServices) {
    const handlers = createProjectHandlers(services);
    return new Elysia({ name: 'scova-projects', prefix: '/api/v1/projects', normalize: false })
        .get('', handlers.list, {
            query: PageQuery,
            response: { 200: ProjectListResponseSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'listProjects',
                summary: '分页查看当前账号的项目',
                description: '按创建时间倒序读取当前账号项目，使用返回的游标继续分页。',
            },
        })
        .post('', handlers.create, {
            body: CreateProjectInputSchema,
            response: { 201: ProjectSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'createProject',
                summary: '创建项目',
                description: '需要会话与 CSRF 校验。项目初始没有关联任务。',
            },
        })
        .get('/:projectId', handlers.detail, {
            params: ProjectParams,
            query: PageQuery,
            response: { 200: ProjectDetailResponseSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'getProject',
                summary: '查看项目、关联任务和近期成果',
                description:
                    '任务按创建时间倒序分页。近期执行与报告各取 5 条，范围由任务的当前归属决定。',
            },
        })
        .delete('/:projectId', handlers.remove, {
            params: ProjectParams,
            response: { 204: t.Void(), ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'deleteProject',
                summary: '删除项目并解除任务关联',
                description: '需要会话与 CSRF 校验。关联任务、执行、报告和任务周期配置均保留。',
            },
        })
        .put('/:projectId/tasks/:taskId', handlers.associate, {
            params: MembershipParams,
            response: { 204: t.Void(), ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'assignProjectTask',
                summary: '把任务关联或移动到项目',
                description:
                    '需要会话与 CSRF 校验。任务与项目须归当前账号，每个任务最多归属一个项目。',
            },
        })
        .delete('/:projectId/tasks/:taskId', handlers.unlink, {
            params: MembershipParams,
            response: { 204: t.Void(), ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'unlinkProjectTask',
                summary: '解除任务与指定项目的关联',
                description:
                    '需要会话与 CSRF 校验。任务已解绑或已移动时，该请求仍成功且保留当前归属。',
            },
        });
}
