import {
    RunGraphSnapshotSchema,
    UuidSchema,
    parseContract,
    type RunGraphSnapshot,
} from '@scova/models';
import { InvalidResponseError } from 'requestlane';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';

const runGraphEndpoint = defineApiEndpoint<{ params: { runId: string }; data: RunGraphSnapshot }>({
    method: 'GET',
    path: '/runs/:runId/graph',
    inputValidators: {
        params: {
            parse(value: unknown) {
                return { runId: parseContract(UuidSchema, (value as { runId?: unknown })?.runId) };
            },
        },
    },
    validator: modelValidator(RunGraphSnapshotSchema),
});

export function runGraphQueryOptions(lifecycle: SessionLifecycle, runId: string) {
    parseContract(UuidSchema, runId);
    const scope = lifecycle.capture();
    const options = lifecycle.queryOptions(runGraphEndpoint, { params: { runId } }, [
        'run-graph',
        runId,
    ]);
    return {
        ...options,
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
            const response = await scope.request(
                runGraphEndpoint,
                { params: { runId } },
                { signal },
            );
            if (response.data.runId !== runId)
                throw toApiError(new InvalidResponseError('运行图快照标识不匹配'));
            const previous = lifecycle.queryClient.getQueryData<typeof response>(options.queryKey);
            // A late GET cannot roll back a higher sequence already observed for
            // the same account/epoch/Run. The watermark handles initially empty caches.
            if (previous?.data.runId === runId && previous.data.seq > response.data.seq)
                return previous;
            return response;
        },
    };
}
