import {
    RunSchema,
    UuidSchema,
    parseContract,
    type Run,
    type Task,
    RunCommandInputSchema,
    RunCommandResponseSchema,
    type RunCommandInput,
    type RunCommandResponse,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import type { SessionLifecycle } from '@/api/session';
import { InvalidResponseError } from 'requestlane';
import { toApiError } from '@/api/errors';
import { modelValidator } from '@/api/validator';

const commandValidator = modelValidator(RunCommandResponseSchema);
const paramsValidator = <Name extends 'taskId' | 'runId'>(name: Name) => ({
    parse(value: unknown) {
        const id = value && typeof value === 'object' ? Reflect.get(value, name) : undefined;
        return { [name]: parseContract(UuidSchema, id) } as Record<Name, string>;
    },
});
const startEndpoint = defineApiEndpoint<{
    params: { taskId: string };
    body: RunCommandInput;
    data: RunCommandResponse;
}>({
    method: 'POST',
    path: '/tasks/:taskId/runs',
    inputValidators: {
        params: paramsValidator('taskId'),
        body: modelValidator(RunCommandInputSchema),
    },
    validator: commandValidator,
});
const retryEndpoint = defineApiEndpoint<{
    params: { runId: string };
    body: RunCommandInput;
    data: RunCommandResponse;
}>({
    method: 'POST',
    path: '/runs/:runId/retry',
    inputValidators: {
        params: paramsValidator('runId'),
        body: modelValidator(RunCommandInputSchema),
    },
    validator: commandValidator,
});
const cancelEndpoint = defineApiEndpoint<{ params: { runId: string }; data: RunCommandResponse }>({
    method: 'POST',
    path: '/runs/:runId/cancel',
    inputValidators: { params: paramsValidator('runId') },
    validator: commandValidator,
});

export type RunActionTarget = {
    taskId: string;
    run?: Run;
    taskStatus?: Task['status'];
    agentProviderId?: string | null;
    outputFormat?: RunCommandInput['outputFormat'];
    outputFormats?: RunCommandInput['outputFormats'];
};
export type RunAction = 'start' | 'retry' | 'cancel';
export interface RunAttempt {
    action: RunAction;
    taskId: string;
    runId?: string;
    taskVersionId?: string;
    budget?: Readonly<Run['budget']>;
    mode: 'live';
    key: string;
    agentProviderId?: string | null;
    outputFormat?: RunCommandInput['outputFormat'];
    outputFormats?: RunCommandInput['outputFormats'];
}
/** 输入由动作控制器冻结；不在此创建 key，也不安装命令快照。 */
export async function requestRunAction(
    scope: ReturnType<SessionLifecycle['capture']>,
    attempt: Readonly<RunAttempt>,
    signal: AbortSignal,
) {
    const options = {
        signal,
        ...(attempt.action !== 'cancel' ? { idempotencyKey: attempt.key } : {}),
    };
    const body: RunCommandInput = {
        mode: attempt.mode,
        ...(attempt.outputFormat !== undefined ? { outputFormat: attempt.outputFormat } : {}),
        ...(attempt.outputFormats !== undefined
            ? { outputFormats: [...attempt.outputFormats] }
            : {}),
        ...(attempt.agentProviderId !== undefined
            ? { agentProviderId: attempt.agentProviderId }
            : {}),
    };
    const response =
        attempt.action === 'start'
            ? await scope.request(
                  startEndpoint,
                  { params: { taskId: attempt.taskId }, body },
                  options,
              )
            : attempt.action === 'retry'
              ? await scope.request(
                    retryEndpoint,
                    { params: { runId: attempt.runId! }, body },
                    options,
                )
              : await scope.request(cancelEndpoint, { params: { runId: attempt.runId! } }, options);
    const { run, reused } = response.data;
    if (
        run.taskId !== attempt.taskId ||
        (attempt.action !== 'cancel' && !reused && run.mode !== attempt.mode) ||
        (attempt.action === 'cancel' && run.id !== attempt.runId) ||
        (attempt.action === 'retry' &&
            !reused &&
            (run.parentRunId !== attempt.runId ||
                run.trigger !== 'retry' ||
                run.taskVersionId !== attempt.taskVersionId ||
                run.id === attempt.runId ||
                (attempt.budget &&
                    Object.entries(attempt.budget).some(
                        ([name, value]) => Reflect.get(run.budget, name) !== value,
                    ))))
    )
        throw toApiError(new InvalidResponseError('执行命令返回资源不匹配'));
    return response;
}

// identity 必须稳定；Run ID 属于参数，不能为每个查询建立新的端点或无界端点缓存。
const runEndpoint = defineApiEndpoint<{ params: { runId: string }; data: Run }>({
    method: 'GET',
    path: '/runs/:runId',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const id =
                    value && typeof value === 'object' && 'runId' in value
                        ? value.runId
                        : undefined;
                return { runId: parseContract(UuidSchema, id) };
            },
        },
    },
    validator: modelValidator(RunSchema),
});

export async function requestRun(
    scope: ReturnType<SessionLifecycle['capture']>,
    runId: string,
    signal?: AbortSignal,
) {
    parseContract(UuidSchema, runId);
    const response = await scope.request(runEndpoint, { params: { runId } }, { signal });
    if (response.data.id !== runId)
        throw toApiError(new InvalidResponseError('执行快照标识不匹配'));
    return response;
}

export function runQueryOptions(lifecycle: SessionLifecycle, runId: string) {
    parseContract(UuidSchema, runId);
    const scope = lifecycle.capture();
    return {
        ...lifecycle.queryOptions(runEndpoint, { params: { runId } }, ['run', runId]),
        queryFn: ({ signal }: { signal: AbortSignal }) => requestRun(scope, runId, signal),
    };
}
