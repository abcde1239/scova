import { requiredDatabaseValue } from '../../../utils/execution/database.ts';
import { toolCalls as dbToolCalls, eq, runs as dbRuns, type JsonValue } from '@scova/db';
import { BudgetSchema, parseContract, toolIssueLevel } from '@scova/models';
import { appendEvent } from '../runs.ts';
import { toolFailures } from '@scova/execution/tool-failure';
import {
    type AgentRepository,
    AgentPersistenceError,
    type AgentTool,
} from '@scova/execution/agent';
import { heldReservation, usage, TOOL_SUMMARIES, jsonValue, reconcileUsage } from './validation.ts';
import type { AgentRepositoryScope } from './scope.ts';

export function createSettlementMethods({
    fence,
    callForSettlement,
}: AgentRepositoryScope): Pick<AgentRepository, 'settle' | 'fail'> {
    return {
        async settle(input) {
            const output = jsonValue(input.output);
            const actual = input.actualUsage === undefined ? undefined : usage(input.actualUsage);
            return fence(async (tx, run, now) => {
                const call = await callForSettlement(tx, input.toolCallId);
                const current = usage(run.usageJson);
                if (call.status === 'succeeded') return { usage: current };
                if (call.status !== 'running' && call.status !== 'reserved')
                    throw new AgentPersistenceError('INVALID_TOOL_CALL');
                const reserved = heldReservation(call).reserved;
                const { settled, nextUsage } = reconcileUsage(current, reserved, actual);
                await tx
                    .update(dbToolCalls)
                    .set({
                        status: 'succeeded',
                        usage: settled,
                        outputRef: { schemaVersion: 1, result: output } as JsonValue,
                        finishedAt: now,
                    })
                    .where(eq(dbToolCalls.id, call.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
                await tx
                    .update(dbRuns)
                    .set({ usageJson: nextUsage })
                    .where(eq(dbRuns.id, run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
                if (!Object.hasOwn(TOOL_SUMMARIES, call.tool))
                    throw new AgentPersistenceError('INVALID_TOOL_CALL');
                await appendEvent(tx, run, now, {
                    type: 'tool.completed',
                    payload: {
                        toolCallId: call.id,
                        tool: call.tool as AgentTool,
                        durationMs: Math.max(0, now.getTime() - (call.startedAt ?? now).getTime()),
                        usage: nextUsage,
                    },
                });
                await appendEvent(tx, run, now, {
                    type: 'budget.updated',
                    payload: {
                        budget: parseContract(BudgetSchema, run.budgetJson),
                        usage: nextUsage,
                    },
                });
                return { usage: nextUsage };
            });
        },

        fail(input) {
            return fence(async (tx, run, now) => {
                const failure =
                    input.failureCode && Object.hasOwn(toolFailures, input.failureCode)
                        ? toolFailures[input.failureCode]
                        : undefined;
                const call = await callForSettlement(tx, input.toolCallId);
                if (call.status !== 'reserved' && call.status !== 'running') return;
                const actual =
                    input.actualUsage === undefined ? undefined : usage(input.actualUsage);
                let nextUsage = usage(run.usageJson);
                if (actual) {
                    const reserved = heldReservation(call).reserved;
                    if (
                        call.tool !== 'model' ||
                        actual.estimated ||
                        actual.searches !== reserved.searches ||
                        actual.pages !== reserved.pages
                    )
                        throw new AgentPersistenceError('INVALID_TOOL_RESULT');
                    nextUsage = reconcileUsage(nextUsage, reserved, actual).nextUsage;
                }
                const code = failure
                    ? input.failureCode!
                    : input.unknown === false
                      ? 'TOOL_FAILED'
                      : 'TOOL_RESULT_UNKNOWN';
                if (!Object.hasOwn(TOOL_SUMMARIES, call.tool))
                    throw new AgentPersistenceError('INVALID_TOOL_CALL');
                await tx
                    .update(dbToolCalls)
                    .set({
                        status: actual || input.unknown === false ? 'failed' : 'unknown',
                        ...(actual ? { usage: actual } : {}),
                        finishedAt: now,
                    })
                    .where(eq(dbToolCalls.id, call.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
                await appendEvent(tx, run, now, {
                    type: 'tool.failed',
                    payload: {
                        toolCallId: call.id,
                        tool: call.tool as AgentTool,
                        code,
                        severity: toolIssueLevel(call.tool as AgentTool, code),
                        message: failure
                            ? failure[0]
                            : input.unknown === false
                              ? '工具调用失败，预留预算保留'
                              : '工具结果未确认，预留预算保留',
                        retryable: failure ? failure[1] : true,
                        ...(call.tool === 'model' && input.modelDiagnostic
                            ? { modelDiagnostic: input.modelDiagnostic }
                            : {}),
                    },
                });
                if (actual) {
                    await tx
                        .update(dbRuns)
                        .set({ usageJson: nextUsage })
                        .where(eq(dbRuns.id, run.id));
                    await appendEvent(tx, run, now, {
                        type: 'budget.updated',
                        payload: {
                            budget: parseContract(BudgetSchema, run.budgetJson),
                            usage: nextUsage,
                        },
                    });
                }
            });
        },
    };
}
