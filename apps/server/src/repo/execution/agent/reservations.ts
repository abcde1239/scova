import { requiredDatabaseValue } from '../../../utils/execution/database.ts';
import {
    toolCalls as dbToolCalls,
    eq,
    and,
    desc,
    runs as dbRuns,
    sql,
    runEvents as dbRunEvents,
} from '@scova/db';
import { BudgetSchema, parseContract } from '@scova/models';
import { appendEvent } from '../runs.ts';
import { type AgentRepository, AgentPersistenceError } from '@scova/shared/execution/agent';
import {
    heldReservation,
    reservation,
    usage,
    completedOutput,
    addUsage,
    TOOL_SUMMARIES,
} from './validation.ts';
import type { AgentRepositoryScope } from './scope.ts';

export function createReservationsMethods({
    token,
    fence,
}: AgentRepositoryScope): Pick<AgentRepository, 'reserve'> {
    return {
        async reserve(input) {
            const reserved = reservation(input);
            return fence(async (tx, run, now) => {
                const current = usage(run.usageJson);
                const calls = await tx.query.toolCalls.findMany({
                    where: and(
                        eq(dbToolCalls.userId, run.userId),
                        eq(dbToolCalls.runId, run.id),
                        eq(dbToolCalls.operationKey, input.operationKey),
                    ),
                    orderBy: [desc(dbToolCalls.attemptNo)],
                });
                if (calls.some((call) => call.tool !== input.tool))
                    throw new AgentPersistenceError('INVALID_TOOL_CALL');
                const completed = calls.find((call) => call.status === 'succeeded');
                if (completed)
                    return {
                        kind: 'reused' as const,
                        toolCallId: completed.id,
                        attemptNo: completed.attemptNo,
                        usage: current,
                        output: completedOutput(completed),
                    };
                // A confirmed billing failure is Run-local and survives lost checkpoints/epochs.
                // Successful earlier operations remain replayable; a new Run starts unblocked.
                if (input.tool === 'model' || reserved.inputTokens > 0) {
                    const blocked = await tx.query.runEvents.findFirst({
                        where: and(
                            eq(dbRunEvents.runId, run.id),
                            eq(dbRunEvents.userId, run.userId),
                            eq(dbRunEvents.type, 'tool.failed'),
                            sql`${dbRunEvents.payload}->>'code' = 'TOOL_MODEL_QUOTA_EXCEEDED'`,
                        ),
                    });
                    if (blocked) throw new AgentPersistenceError('MODEL_QUOTA_EXCEEDED');
                }
                for (const call of calls) {
                    if (call.status !== 'reserved' && call.status !== 'running') continue;
                    if (heldReservation(call).leaseEpoch === token.leaseEpoch)
                        throw new AgentPersistenceError('TOOL_CALL_BUSY');
                    await tx
                        .update(dbToolCalls)
                        .set({ status: 'unknown', finishedAt: now })
                        .where(eq(dbToolCalls.id, call.id))
                        .returning()
                        .then((rows) => requiredDatabaseValue(rows[0]));
                }
                const attemptNo = (calls[0]?.attemptNo ?? 0) + 1;
                if (!Number.isSafeInteger(attemptNo) || attemptNo > 2_147_483_647)
                    throw new AgentPersistenceError('INVALID_TOOL_CALL');
                const nextUsage = addUsage(current, reserved, run);
                const call = await tx
                    .insert(dbToolCalls)
                    .values({
                        userId: run.userId,
                        runId: run.id,
                        operationKey: input.operationKey,
                        tool: input.tool,
                        attemptNo: attemptNo,
                        status: 'running',
                        inputSummary: TOOL_SUMMARIES[input.tool],
                        reservedBudget: {
                            schemaVersion: 1,
                            leaseEpoch: token.leaseEpoch,
                            reserved,
                        },
                        startedAt: now,
                    })
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
                await tx
                    .update(dbRuns)
                    .set({ usageJson: nextUsage })
                    .where(eq(dbRuns.id, run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
                await appendEvent(tx, run, now, {
                    type: 'tool.started',
                    payload: {
                        toolCallId: call.id,
                        tool: input.tool,
                        summary: TOOL_SUMMARIES[input.tool],
                        ...(input.tool === 'search' && input.searchProvider
                            ? { searchProvider: input.searchProvider }
                            : {}),
                    },
                });
                await appendEvent(tx, run, now, {
                    type: 'budget.updated',
                    payload: {
                        budget: parseContract(BudgetSchema, run.budgetJson),
                        usage: nextUsage,
                    },
                });
                return {
                    kind: 'reserved' as const,
                    toolCallId: call.id,
                    attemptNo,
                    usage: nextUsage,
                };
            });
        },
    };
}
