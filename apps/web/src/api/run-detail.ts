import {
    ReportListQuerySchema,
    ReportListResponseSchema,
    type ReportListQuery,
} from '@scova/models';
import { InvalidResponseError } from 'requestlane';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';
import type { SessionLifecycle } from '@/api/session';

const reportsEndpoint = defineApiEndpoint<{
    query: ReportListQuery;
    data: typeof ReportListResponseSchema.static;
}>({
    method: 'GET',
    path: '/reports',
    inputValidators: { query: modelValidator(ReportListQuerySchema) },
    validator: modelValidator(ReportListResponseSchema),
});

export function runReportsOptions(lifecycle: SessionLifecycle, taskId: string, runId: string) {
    const scope = lifecycle.capture();
    return {
        queryKey: scope.queryKey(['reports', 'for-run', taskId, runId]),
        initialPageParam: undefined as string | undefined,
        queryFn: async ({
            signal,
            pageParam,
        }: {
            signal: AbortSignal;
            pageParam: string | undefined;
        }) => {
            const response = await scope.request(
                reportsEndpoint,
                {
                    query: { taskId, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
                },
                { signal },
            );
            if (response.data.items.some((report) => report.taskId !== taskId))
                throw new InvalidResponseError('报告不属于当前任务');
            return response.data;
        },
        getNextPageParam: (
            page: typeof ReportListResponseSchema.static,
            pages: (typeof ReportListResponseSchema.static)[],
        ) => {
            const next = page.nextCursor;
            return next && !pages.slice(0, -1).some((previous) => previous.nextCursor === next)
                ? next
                : undefined;
        },
    };
}
