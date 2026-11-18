import {
    RunGraphSnapshotSchema,
    RunEventSchema,
    parseContract,
    runGraphSnapshot,
    reduceRunGraphEvent,
    reconcileRunGraphStatus,
    type RunGraphState,
} from '@scova/models';
import type { ApiServices } from '@/app/services.ts';
import { createRunGraphRepository } from '@/repo/run-graph.ts';
import { ApiError } from '@/utils/errors.ts';
import { isUuid } from '@/utils/security.ts';

export function createRunGraphService(services: Pick<ApiServices, 'db'>) {
    const repository = createRunGraphRepository(() => services.db());
    return {
        async get(userId: string, runId: string) {
            if (!isUuid(runId)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
            const result = await repository.read(userId, runId);
            let state: RunGraphState | null = result.projection;
            for (const event of result.events) {
                state = reduceRunGraphEvent(
                    state,
                    parseContract(RunEventSchema, {
                        schemaVersion: event.schemaVersion,
                        eventId: event.id,
                        runId: event.runId,
                        seq: event.seq,
                        occurredAt: event.occurredAt.toISOString(),
                        type: event.type,
                        payload: event.payload,
                    }),
                );
            }
            state ??= {
                runId,
                graphVersion: null,
                precision: 'legacy',
                seq: 0,
                runStatus: result.run.status,
                instances: [],
                legacySteps: [],
                historyComplete: false,
                truncated: false,
            };
            if (result.truncated) {
                state.truncated = true;
                state.historyComplete = false;
                state.precision = 'legacy';
            }
            return parseContract(
                RunGraphSnapshotSchema,
                reconcileRunGraphStatus(runGraphSnapshot(state), result.run.status),
            );
        },
    };
}
