import { type DatabaseClient, runs as dbRuns, eq, and, reports as dbReports } from '@scova/db';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { AgentCandidate } from '@scova/agent-core';

import { createDeliveryRepository } from '@/repo/delivery.ts';
import { RunExecutionError, type RunLeaseToken } from '@/utils/runs.ts';

/** Trusted worker only. Reads one explicitly promoted checkpoint, never the latest raw state. */
export function createDeliveryService(database: DatabaseClient, saver: PostgresSaver) {
    const repository = createDeliveryRepository(database);
    return {
        async deliver(token: RunLeaseToken, candidate: AgentCandidate, deadline = false) {
            if (deadline) return repository.deliver(token, { candidate, deadline });
            const run = await database.query.runs.findFirst({
                where: and(eq(dbRuns.id, token.runId), eq(dbRuns.userId, token.userId)),
            });
            if (!run) throw new RunExecutionError('INVALID_DELIVERY_EVIDENCE');
            const existing = await database.query.reports.findFirst({
                where: and(eq(dbReports.userId, token.userId), eq(dbReports.runId, token.runId)),
            });
            if (existing) return { reportId: existing.id, reused: true };
            const ref = run.checkpointRef as {
                threadId?: string;
                namespace?: string;
                checkpointId?: string;
                leaseEpoch?: number;
            } | null;
            if (
                !ref ||
                ref.threadId !== `run-${run.id}-epoch-${token.leaseEpoch}` ||
                ref.leaseEpoch !== token.leaseEpoch ||
                ref.namespace !== '' ||
                typeof ref.checkpointId !== 'string'
            )
                throw new RunExecutionError('INVALID_DELIVERY_EVIDENCE');
            const tuple = await saver.getTuple({
                configurable: {
                    thread_id: ref.threadId,
                    checkpoint_ns: '',
                    checkpoint_id: ref.checkpointId,
                },
            });
            if (!tuple || tuple.checkpoint.id !== ref.checkpointId)
                throw new RunExecutionError('INVALID_DELIVERY_EVIDENCE');
            return repository.deliver(token, {
                candidate,
                deadline,
                checkpointRef: ref,
                research: tuple.checkpoint.channel_values.research,
            });
        },
    };
}
