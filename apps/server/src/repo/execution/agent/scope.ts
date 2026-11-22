import {
    type DatabaseClient,
    type Run,
    toolCalls as dbToolCalls,
    eq,
    and,
    type DatabaseTransaction,
} from '@scova/db';
import { withRunFence } from '../runs.ts';
import type { RunLeaseToken } from '@scova/shared/execution/runs';
import { AgentPersistenceError } from '@scova/shared/execution/agent';
import { heldReservation } from './validation.ts';

export function createAgentRepositoryScope(db: DatabaseClient, token: RunLeaseToken) {
    const fence = <T>(operation: (tx: DatabaseTransaction, run: Run, now: Date) => Promise<T>) =>
        withRunFence(db, token, 'work', operation);

    const callForSettlement = async (tx: DatabaseTransaction, id: string) => {
        const call = await tx.query.toolCalls.findFirst({
            where: and(
                eq(dbToolCalls.id, id),
                eq(dbToolCalls.userId, token.userId),
                eq(dbToolCalls.runId, token.runId),
            ),
        });
        if (!call || heldReservation(call).leaseEpoch !== token.leaseEpoch)
            throw new AgentPersistenceError('INVALID_TOOL_CALL');
        return call;
    };
    return { db, token, fence, callForSettlement };
}
export type AgentRepositoryScope = ReturnType<typeof createAgentRepositoryScope>;
