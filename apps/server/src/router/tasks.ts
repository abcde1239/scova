import { Elysia, t } from 'elysia';
import {
    CreateTaskInputSchema,
    CreateProjectInputSchema,
    CreateAndStartTaskResponseSchema,
    IdempotencyHeadersSchema,
    ApiErrorSchema,
    PageQuerySchema,
    ProjectSchema,
    RevisionHeadersSchema,
    TaskDetailResponseSchema,
    TaskListResponseSchema,
    TaskProjectResponseSchema,
    TaskSchema,
    TaskVersionSchema,
    UpdateTaskInputSchema,
    UuidSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createTaskHandlers } from '@/handler/tasks.ts';

// URL 查询串使用 Elysia 数值解码；service 继续按共享整数契约校验。
const HttpPageQuerySchema = t.Object(
    {
        ...PageQuerySchema.properties,
        limit: t.Optional(
            t.Numeric({
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER,
                description: PageQuerySchema.properties.limit.description,
            }),
        ),
    },
    { additionalProperties: false, description: PageQuerySchema.description },
);

const TaskProjectParams = t.Object({ taskId: UuidSchema });

const OptionalRevisionHeadersSchema = t.Object(
    {
        'if-match': t.Optional(
            t.String({
                pattern: '^"[1-9][0-9]*"$',
                description: '编辑时提交读取到的 ETag，例如 "3"',
            }),
        ),
    },
    { additionalProperties: true, description: '编辑任务时的乐观锁请求头；缺失时返回 428' },
);

export function createTaskPlugin(services: ApiServices) {
    const handlers = createTaskHandlers(services);
    const errors = {
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        412: ApiErrorSchema,
        422: ApiErrorSchema,
    } as const;
    return new Elysia({ name: 'scova-tasks', prefix: '/api/v1', normalize: false })
        .model({
            CreateTaskInput: CreateTaskInputSchema,
            UpdateTaskInput: UpdateTaskInputSchema,
            PageQuery: PageQuerySchema,
            RevisionHeaders: RevisionHeadersSchema,
            Task: TaskSchema,
            TaskVersion: TaskVersionSchema,
            TaskDetailResponse: TaskDetailResponseSchema,
            TaskListResponse: TaskListResponseSchema,
        })
        .get('/tasks', handlers.list, {
            query: HttpPageQuerySchema,
            response: { 200: TaskListResponseSchema, ...errors },
            detail: {
                operationId: 'listTasks',
                tags: ['任务'],
                summary: '查看任务列表',
                description: '按更新时间倒序返回当前账号拥有的长期查阅任务，使用不透明游标分页。',
            },
        })
        .post('/tasks', handlers.create, {
            headers: t.Partial(IdempotencyHeadersSchema),
            body: 'CreateTaskInput',
            response: { 201: TaskDetailResponseSchema, ...errors },
            detail: {
                operationId: 'createTask',
                tags: ['任务'],
                summary: '创建查阅任务',
                description:
                    '保存用户确认的配置并创建不可变版本。可提供幂等键重放原创建，重复使用该键提交不同参数时返回冲突。',
            },
        })
        .post('/tasks/start', handlers.start, {
            headers: IdempotencyHeadersSchema,
            body: 'CreateTaskInput',
            response: { 201: CreateAndStartTaskResponseSchema, ...errors },
            detail: {
                operationId: 'startTask',
                tags: ['任务'],
                summary: '创建查阅任务并立即运行',
                description:
                    '原子保存未归类任务与配置版本，创建并入队执行。需要会话、CSRF 和 Idempotency-Key。同键同参数重放原结果，同键不同参数返回409。',
            },
        })
        .get('/tasks/:taskId/project', handlers.getProject, {
            params: TaskProjectParams,
            response: { 200: TaskProjectResponseSchema, ...errors },
            detail: {
                operationId: 'getTaskProject',
                tags: ['任务'],
                summary: '查看任务所属项目',
                description:
                    '仅当前账号拥有的任务可查询。未归类时项目为空，跨账号或不存在时返回404。',
            },
        })
        .post('/tasks/:taskId/project', handlers.createProject, {
            params: TaskProjectParams,
            body: CreateProjectInputSchema,
            response: { 201: ProjectSchema, ...errors },
            detail: {
                operationId: 'createProjectForTask',
                tags: ['任务'],
                summary: '为未归类任务新建项目',
                description:
                    '原子创建项目并归入当前账号的任务。需要会话和 CSRF。任务已归类时返回409，跨账号或不存在时返回404。',
            },
        })
        .get('/tasks/:taskId', handlers.get, {
            response: { 200: TaskDetailResponseSchema, ...errors },
            detail: {
                operationId: 'getTask',
                tags: ['任务'],
                summary: '查看任务详情',
                description:
                    '返回当前账号的任务摘要及不可变配置版本；不存在或跨账号资源统一返回404。',
            },
        })
        .delete('/tasks/:taskId', handlers.remove, {
            headers: OptionalRevisionHeadersSchema,
            response: { 204: t.Void(), ...errors, 428: ApiErrorSchema },
            detail: {
                operationId: 'deleteTask',
                tags: ['任务'],
                summary: '永久清除任务及关联历史',
                description:
                    '需要会话、CSRF 和 If-Match。存在活动执行时返回409；原子删除任务版本、执行、报告、通知、报告笔记及问答，保留共享来源、快照和来源收藏。不可恢复。',
            },
        })
        .patch('/tasks/:taskId', handlers.update, {
            body: 'UpdateTaskInput',
            headers: OptionalRevisionHeadersSchema,
            response: { 200: TaskDetailResponseSchema, ...errors, 428: ApiErrorSchema },
            detail: {
                operationId: 'updateTask',
                tags: ['任务'],
                summary: '编辑任务并创建新版本',
                description:
                    '使用 If-Match 乐观锁保存不可变配置版本；标题、计划、展示格式和提醒修改不会重置比较范围，语义范围变化会明确提示新基线。',
            },
        })
        .post('/tasks/:taskId/pause', handlers.pause, {
            headers: OptionalRevisionHeadersSchema,
            response: { 200: TaskDetailResponseSchema, ...errors, 428: ApiErrorSchema },
            detail: {
                operationId: 'pauseTask',
                tags: ['任务'],
                summary: '暂停周期计划',
                description:
                    '需要会话、CSRF 和 If-Match。停止后续周期触发，当前执行继续；用户仍可显式手动运行。',
            },
        })
        .post('/tasks/:taskId/resume', handlers.resume, {
            headers: OptionalRevisionHeadersSchema,
            response: { 200: TaskDetailResponseSchema, ...errors, 428: ApiErrorSchema },
            detail: {
                operationId: 'resumeTask',
                tags: ['任务'],
                summary: '恢复周期计划',
                description:
                    '需要会话、CSRF 和 If-Match。使用加锁后的数据库时间计算严格未来的计划，不补跑暂停期间的历史时点。',
            },
        })
        .post('/tasks/:taskId/archive', handlers.archive, {
            headers: OptionalRevisionHeadersSchema,
            response: { 200: TaskDetailResponseSchema, ...errors, 428: ApiErrorSchema },
            detail: {
                operationId: 'archiveTask',
                tags: ['任务'],
                summary: '归档查阅任务',
                description:
                    '需要会话、CSRF 和 If-Match。在同一事务停止周期计划并对活动执行请求取消，保留配置版本、报告和历史；归档后拒绝新执行。',
            },
        });
}
