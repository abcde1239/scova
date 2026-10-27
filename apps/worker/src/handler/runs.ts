import type { RunService, RunExecutionResult } from '@/service/runs.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 队列输入仅可选择 runId，owner、模式、版本和预算始终由 PostgreSQL 加载。 */
export function createRunHandler(service: Pick<RunService, 'execute'>) {
    return (name: string, data: unknown, signal?: AbortSignal): Promise<RunExecutionResult> => {
        if (
            (name !== 'run.enqueue' && name !== 'run.cancel_requested') ||
            !data ||
            typeof data !== 'object' ||
            !('runId' in data) ||
            typeof data.runId !== 'string' ||
            !UUID.test(data.runId)
        )
            return Promise.resolve('ignored');
        return service.execute(data.runId, signal);
    };
}
