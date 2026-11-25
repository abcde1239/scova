import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    CreateProjectThreadSchema,
    PROJECT_THREAD_MAX_PAGE_SIZE,
    PROJECT_THREAD_MAX_SEQ,
    ProjectThreadListSchema,
    ProjectTurnReceiptSchema,
    ProjectActionReceiptSchema,
    ProjectScheduleActionReceiptSchema,
    SendProjectTurnSchema,
    ProjectThreadSchema,
    ProjectThreadSnapshotSchema,
    UpdateProjectThreadSchema,
    UuidSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createThreadHandlers } from '@/handler/threads.ts';

const ProjectParams = t.Object({ projectId: UuidSchema });
const ThreadParams = t.Object({ threadId: UuidSchema });
const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    409: ApiErrorSchema,
    422: ApiErrorSchema,
} as const;
const actionReceipt = t.Union([ProjectActionReceiptSchema, ProjectScheduleActionReceiptSchema]);
const afterParameter = {
    in: 'query',
    name: 'after',
    description: '最后已处理的会话条目序号',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: PROJECT_THREAD_MAX_SEQ },
} as const;

export function createThreadPlugin(services: ApiServices) {
    const handlers = createThreadHandlers(services);
    return new Elysia({ name: 'scova-project-threads', prefix: '/api/v1', normalize: false })
        .get('/projects/:projectId/threads', handlers.list, {
            params: ProjectParams,
            response: { 200: ProjectThreadListSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'listProjectThreads',
                summary: '查看项目会话',
                description: '列出本人项目的会话，包含已归档会话。',
            },
        })
        .post('/projects/:projectId/threads', handlers.create, {
            params: ProjectParams,
            body: CreateProjectThreadSchema,
            response: { 201: ProjectThreadSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'createProjectThread',
                summary: '创建项目会话',
                description: '需要会话与 CSRF 校验。',
            },
        })
        .patch('/threads/:threadId', handlers.update, {
            params: ThreadParams,
            body: UpdateProjectThreadSchema,
            response: { 200: ProjectThreadSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'updateProjectThread',
                summary: '修改项目会话标题或归档状态',
                description: '需要会话与 CSRF 校验。',
            },
        })
        .get('/threads/:threadId', handlers.snapshot, {
            params: ThreadParams,
            response: { 200: ProjectThreadSnapshotSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'getProjectThreadSnapshot',
                summary: '分页读取项目会话快照',
                description: '读取当前可见的条目，按序号从小到大返回。',
                parameters: [
                    afterParameter,
                    {
                        in: 'query',
                        name: 'limit',
                        required: false,
                        schema: {
                            type: 'integer',
                            minimum: 1,
                            maximum: PROJECT_THREAD_MAX_PAGE_SIZE,
                        },
                    },
                ],
            },
        })
        .post('/threads/:threadId/turns', handlers.send, {
            params: ThreadParams,
            body: SendProjectTurnSchema,
            response: { 200: ProjectTurnReceiptSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'sendProjectThreadTurn',
                summary: '发送项目会话消息',
                description: '判定输入意图并追加会话条目。同轮次标识可重放。',
            },
        })
        .post('/threads/:threadId/turns/:turnId/cancel', handlers.cancel, {
            params: t.Object({ threadId: UuidSchema, turnId: UuidSchema }),
            response: { 200: ProjectTurnReceiptSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'cancelProjectThreadTurn',
                summary: '停止本轮会话',
                description: '中止该会话正在运行的轮次并保留历史条目。',
            },
        })
        .post('/threads/:threadId/items/:itemId/approve', handlers.approve, {
            params: t.Object({ threadId: UuidSchema, itemId: UuidSchema }),
            response: { 200: actionReceipt, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'approveProjectAction',
                summary: '批准会话动作',
                description: '应用当前待确认的研究或周期动作，重复批准复用首个回执。',
            },
        })
        .post('/threads/:threadId/items/:itemId/reject', handlers.reject, {
            params: t.Object({ threadId: UuidSchema, itemId: UuidSchema }),
            response: { 200: actionReceipt, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'rejectProjectAction',
                summary: '拒绝会话动作',
                description: '拒绝该会话的待确认动作并记录决定。',
            },
        })
        .post('/threads/:threadId/items/:itemId/undo', handlers.undo, {
            params: t.Object({ threadId: UuidSchema, itemId: UuidSchema }),
            response: { 200: ProjectScheduleActionReceiptSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'undoProjectScheduleAction',
                summary: '撤销会话周期动作',
                description: '任务修订保持对应状态时，撤销已应用的周期动作。',
            },
        })
        .get('/threads/:threadId/events', handlers.events, {
            params: ThreadParams,
            detail: {
                tags: ['项目'],
                operationId: 'streamProjectThreadItems',
                summary: '订阅项目会话条目',
                description:
                    '按会话条目序号有界回放并持续推送新条目。item 事件的 id 为条目序号；显式 after 优先于 Last-Event-ID。',
                parameters: [
                    afterParameter,
                    {
                        in: 'header',
                        name: 'Last-Event-ID',
                        description: '未提供 after 时使用的最后已处理会话条目序号',
                        required: false,
                        schema: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
                    },
                ],
                responses: {
                    200: {
                        description: 'item 事件与注释心跳',
                        content: { 'text/event-stream': { schema: { type: 'string' } } },
                    },
                },
            },
        });
}
