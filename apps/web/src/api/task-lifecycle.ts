import {
    TaskDetailResponseSchema,
    UuidSchema,
    parseContract,
    parseRevisionEtag,
    type TaskDetailResponse,
} from '@scova/models';
import { InvalidResponseError } from 'requestlane';
import type { ApiResponse } from '@/api/client';
import { defineApiEndpoint } from '@/api/endpoints';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { taskEndpoint, taskKeys } from '@/api/tasks';
import { modelValidator, voidValidator } from '@/api/validator';

export type TaskLifecycleAction = 'pause' | 'resume' | 'archive';
const desiredStatus = { pause: 'paused', resume: 'active', archive: 'archived' } as const;
const paramsValidator = {
    parse(value: unknown) {
        const id = value && typeof value === 'object' ? Reflect.get(value, 'taskId') : undefined;
        return { taskId: parseContract(UuidSchema, id) };
    },
};
const deleteEndpoint = defineApiEndpoint<{ params: { taskId: string }; data: void }>({
    method: 'DELETE',
    path: '/tasks/:taskId',
    inputValidators: { params: paramsValidator },
    validator: voidValidator,
});
export function requestTaskDeletion(
    scope: ReturnType<SessionLifecycle['capture']>,
    snapshot: ApiResponse<TaskDetailResponse>,
    signal: AbortSignal,
) {
    validateLifecycleSnapshot(snapshot, snapshot.data.task.id);
    return scope.request(
        deleteEndpoint,
        { params: { taskId: snapshot.data.task.id } },
        { ifMatch: snapshot.headers.etag, signal },
    );
}
const endpoint = (action: TaskLifecycleAction) =>
    defineApiEndpoint<{
        params: { taskId: string };
        data: TaskDetailResponse;
    }>({
        method: 'POST',
        path: `/tasks/:taskId/${action}`,
        inputValidators: { params: paramsValidator },
        validator: modelValidator(TaskDetailResponseSchema),
    });
const endpoints = {
    pause: endpoint('pause'),
    resume: endpoint('resume'),
    archive: endpoint('archive'),
};

export function validateLifecycleSnapshot(
    response: ApiResponse<TaskDetailResponse>,
    taskId: string,
) {
    const { task, version } = response.data;
    const etag = response.headers.etag;
    if (
        task.id !== taskId ||
        version.taskId !== taskId ||
        task.currentVersionId !== version.id ||
        (task.status !== 'active' && task.nextRunAt !== null) ||
        !etag ||
        parseRevisionEtag(etag) !== task.revision
    )
        throw toApiError(new InvalidResponseError('任务状态、版本或 ETag 不一致'));
    return response;
}

export function taskLifecycleOptions(lifecycle: SessionLifecycle, taskId: string) {
    const options = lifecycle.queryOptions(taskEndpoint, { params: { taskId } }, [
        ...taskKeys.detail(taskId),
        'lifecycle',
    ]);
    return {
        ...options,
        enabled: false,
        async queryFn(context: { signal: AbortSignal }) {
            return validateLifecycleSnapshot(await options.queryFn(context), taskId);
        },
    };
}

export async function requestTaskLifecycle(
    scope: ReturnType<SessionLifecycle['capture']>,
    action: TaskLifecycleAction,
    snapshot: ApiResponse<TaskDetailResponse>,
    signal: AbortSignal,
) {
    const id = snapshot.data.task.id;
    validateLifecycleSnapshot(snapshot, id);
    const result = validateLifecycleSnapshot(
        await scope.request(
            endpoints[action],
            { params: { taskId: id } },
            { ifMatch: snapshot.headers.etag, signal },
        ),
        id,
    );
    if (
        result.data.task.status !== desiredStatus[action] ||
        result.data.task.revision !== snapshot.data.task.revision + 1 ||
        result.data.version.id !== snapshot.data.version.id
    )
        throw toApiError(new InvalidResponseError('任务控制返回状态或版本不匹配'));
    return result;
}
