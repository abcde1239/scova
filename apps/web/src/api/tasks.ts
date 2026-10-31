import {
    PageQuerySchema,
    TaskListResponseSchema,
    TaskDetailResponseSchema,
    RunListResponseSchema,
    UuidSchema,
    CreateTaskInputSchema,
    type CreateTaskInput,
    type PageQuery,
    type TaskListResponse,
    type TaskDetailResponse,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

const runListValidator = modelValidator(RunListResponseSchema);
type RunListResponse = ReturnType<typeof runListValidator.parse>;
const taskParamsValidator = {
    parse(value: unknown) {
        if (!value || typeof value !== 'object' || !('taskId' in value))
            throw new TypeError('缺少任务标识');
        return { taskId: modelValidator(UuidSchema).parse(value.taskId) };
    },
};

export const tasksEndpoint = defineApiEndpoint<{ query: PageQuery; data: TaskListResponse }>({
    method: 'GET',
    path: '/tasks',
    inputValidators: { query: modelValidator(PageQuerySchema) },
    validator: modelValidator(TaskListResponseSchema),
});

export const createTaskEndpoint = defineApiEndpoint<{
    body: CreateTaskInput;
    data: TaskDetailResponse;
}>({
    method: 'POST',
    path: '/tasks',
    inputValidators: { body: modelValidator(CreateTaskInputSchema) },
    validator: modelValidator(TaskDetailResponseSchema),
});

export const taskEndpoint = defineApiEndpoint<{
    params: { taskId: string };
    data: TaskDetailResponse;
}>({
    method: 'GET',
    path: '/tasks/:taskId',
    inputValidators: {
        params: taskParamsValidator,
    },
    validator: modelValidator(TaskDetailResponseSchema),
});

export const taskRunsEndpoint = defineApiEndpoint<{
    params: { taskId: string };
    query: PageQuery;
    data: RunListResponse;
}>({
    method: 'GET',
    path: '/tasks/:taskId/runs',
    inputValidators: {
        params: taskParamsValidator,
        query: modelValidator(PageQuerySchema),
    },
    validator: runListValidator,
});

export const taskKeys = {
    all: ['tasks'] as const,
    list: (filter: string) => ['tasks', 'list', filter] as const,
    detail: (id: string) => ['tasks', id] as const,
    runs: (id: string) => ['runs', 'task', id] as const,
};
