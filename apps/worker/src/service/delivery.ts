import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { AgentCandidate } from '@scova/agent-core';
import type { PrismaClient } from '@scova/db';
import { createDeliveryRepository } from '@/repo/delivery.ts';
import { RunExecutionError, type RunLeaseToken } from '@/utils/runs.ts';

/** Trusted worker only. Reads one explicitly promoted checkpoint, never the latest raw state. */
export function createDeliveryService(database: PrismaClient, saver: PostgresSaver) {
    const repository = createDeliveryRepository(database);
    return {
        async deliver(token: RunLeaseToken, candidate: AgentCandidate, deadline = false) {
            if (deadline) return repository.deliver(token, { candidate, deadline });
            const run = await database.run.findFirst({
                where: { id: token.runId, userId: token.userId },
            });
            if (!run) throw new RunExecutionError('INVALID_DELIVERY_EVIDENCE');
            const existing = await database.report.findUnique({
                where: { userId_runId: { userId: token.userId, runId: token.runId } },
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
