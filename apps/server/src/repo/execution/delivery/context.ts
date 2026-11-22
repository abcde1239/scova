import {
    type Run,
    eq,
    and,
    taskVersions as dbTaskVersions,
    toolCalls as dbToolCalls,
    asc,
    type DatabaseTransaction,
} from '@scova/db';
import { type AgentContext } from '@scova/agent-core';
import {
    BudgetSchema,
    TaskConfigSchema,
    UsageSchema,
    parseContract,
    ReportConversationContextSchema,
    readFeedbackSnapshot,
} from '@scova/models';
import { loadBaseline } from '../comparison.ts';
import { invalid } from '../../../utils/execution/delivery.ts';

function contextFor(run: Run, config: AgentContext['config']): AgentContext {
    return {
        ...(run.conversationContextJson
            ? {
                  conversation: parseContract(
                      ReportConversationContextSchema,
                      run.conversationContextJson,
                  ),
              }
            : {}),
        runId: run.id,
        userId: run.userId,
        taskVersionId: run.taskVersionId,
        mode: run.mode,
        config,
        budget: parseContract(BudgetSchema, run.budgetJson),
        usage: parseContract(UsageSchema, run.usageJson),
        startedAt: run.startedAt!,
        deadlineAt: run.deadlineAt!,
        signal: new AbortController().signal,
        assertActive: async () => undefined,
        feedback: readFeedbackSnapshot(run.feedbackSnapshotJson, run.userId, run.taskId),
    };
}

export async function loadDeliveryInputs(tx: DatabaseTransaction, run: Run) {
    const version = await tx.query.taskVersions.findFirst({
        where: and(
            eq(dbTaskVersions.id, run.taskVersionId),
            eq(dbTaskVersions.userId, run.userId),
            eq(dbTaskVersions.taskId, run.taskId),
        ),
    });
    if (!version) return invalid();
    const config = parseContract(TaskConfigSchema, run.followupConfigJson ?? version.configJson);
    const context = contextFor(run, config);
    context.comparisonScopeHash = run.comparisonScopeHash;
    context.baselineRunId = run.baselineRunId;
    context.baseline = await loadBaseline(tx, run);
    const calls = await tx.query.toolCalls.findMany({
        where: and(eq(dbToolCalls.userId, run.userId), eq(dbToolCalls.runId, run.id)),
        orderBy: [asc(dbToolCalls.operationKey), asc(dbToolCalls.attemptNo)],
    });
    return { config, context, calls };
}
