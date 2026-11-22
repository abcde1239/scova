import { type DatabaseClient, runs as dbRuns, eq, and, reports as dbReports } from '@scova/db';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { ExecutionCandidate } from '@scova/shared/execution/protocol';
import type { AgentCandidate } from '@scova/agent-core';

import {
    createDeliveryRepository,
    findBaseline,
    loadDeliveryInputs,
    saveReport,
    saveSources,
} from '../../repo/execution/delivery.ts';
import {
    applyBaselineGaps,
    authenticateCandidate,
    deliveryOutcome,
    finalizeCoverage,
    type DeliveryProof,
} from './delivery-proof.ts';
import { checkpointRef } from '../../repo/execution/agent/validation.ts';
import { invalid } from '../../utils/execution/delivery.ts';
import { RunExecutionError, type RunLeaseToken } from '@scova/shared/execution/runs';

/** Trusted worker only. Reads one explicitly promoted checkpoint, never the latest raw state. */
export function createDeliveryService(database: DatabaseClient, saver: PostgresSaver) {
    const repository = createDeliveryRepository(database);
    const settle = (token: RunLeaseToken, raw: DeliveryProof) => {
        const proof = structuredClone(raw);
        return repository.inRunFence(token, proof.deadline, async (tx, run, now) => {
            if (proof.deadline && (!run.deadlineAt || run.deadlineAt > now)) invalid();
            const { config, context, calls } = await loadDeliveryInputs(tx, run);
            const successful = calls.filter(
                (call) =>
                    call.status === 'succeeded' &&
                    call.finishedAt &&
                    call.finishedAt <= run.deadlineAt!,
            );
            const candidate = authenticateCandidate(run, context, proof, successful);
            finalizeCoverage(candidate, run, config, proof, calls, successful);
            const pageRecords = await saveSources(tx, run, now, candidate, successful);
            applyBaselineGaps(candidate, await findBaseline(tx, run), run, context);
            const { complete, changes, outcome } = deliveryOutcome(candidate, run);
            return saveReport(tx, run, now, {
                candidate,
                config,
                context,
                pageRecords,
                complete,
                outcome,
                changes,
            });
        });
    };
    return {
        async deliver(
            token: RunLeaseToken,
            candidate: AgentCandidate | ExecutionCandidate,
            deadline = false,
            compact = false,
        ) {
            const run = await database.query.runs.findFirst({
                where: and(eq(dbRuns.id, token.runId), eq(dbRuns.userId, token.userId)),
            });
            if (!run) throw new RunExecutionError('INVALID_DELIVERY_EVIDENCE');
            const existing = await database.query.reports.findFirst({
                where: and(eq(dbReports.userId, token.userId), eq(dbReports.runId, token.runId)),
            });
            if (existing) return { reportId: existing.id, reused: true };
            const proof = compact ? { candidate, deadline, compact } : { candidate, deadline };
            if (deadline && run.checkpointRef === null) return settle(token, proof);
            let ref;
            try {
                ref = checkpointRef(run.checkpointRef, run.id, token.leaseEpoch);
            } catch {
                throw new RunExecutionError('INVALID_DELIVERY_EVIDENCE');
            }
            if (!deadline && ref.leaseEpoch !== token.leaseEpoch)
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
            return settle(token, {
                ...proof,
                checkpointRef: ref,
                research: tuple.checkpoint.channel_values.research,
            });
        },
    };
}
