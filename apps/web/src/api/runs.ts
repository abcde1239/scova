import { RunSchema, UuidSchema, parseContract, type Run } from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import type { SessionLifecycle } from '@/api/session';
import { InvalidResponseError } from 'requestlane';
import { toApiError } from '@/api/errors';
import { modelValidator } from '@/api/validator';

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
