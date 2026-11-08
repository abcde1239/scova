import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    type DatabaseClient,
    type Run,
    type ToolCall,
    toolCalls as dbToolCalls,
    eq,
    and,
    desc,
    runs as dbRuns,
    inArray,
    lte,
    asc,
    sql,
    runEvents as dbRunEvents,
    type DatabaseTransaction,
    type JsonValue,
} from '@scova/db';
import {
    BudgetSchema,
    UsageSchema,
    parseContract,
    readFeedbackSnapshot,
    toolIssueLevel,
    type Usage,
    type FeedbackSnapshot,
} from '@scova/models';

import { appendEvent, withRunFence } from '@/repo/runs.ts';
import type { RunLeaseToken } from '@/utils/runs.ts';
import { loadBaseline } from '@/repo/comparison.ts';
import { toolFailures, type ToolFailureCode } from '@/utils/tool-failure.ts';
import type { AgentBaseline } from '@scova/agent-core';

export type AgentTool = 'search' | 'read' | 'model';
export type AgentJson =
    | null
    | boolean
    | number
    | string
    | AgentJson[]
    | { [key: string]: AgentJson };
export interface AgentCheckpointRef {
    threadId: string;
    namespace: '';
    checkpointId: string;
    leaseEpoch: number;
}
export interface AgentReservationInput {
    operationKey: string;
    tool: AgentTool;
    reserved: Usage;
    /** 只接受接口兼容；数据库始终使用固定工具摘要，不保存调用方文本。 */
    inputSummary?: string;
}
export type AgentReservation = {
    toolCallId: string;
    attemptNo: number;
    usage: Usage;
} & ({ kind: 'reserved' } | { kind: 'reused'; output: AgentJson });

export interface AgentRepository {
    comparison(options?: { allowDeadline?: boolean }): Promise<{
        comparisonScopeHash: string;
        baselineRunId: string | null;
        baseline: AgentBaseline | null;
        feedback: FeedbackSnapshot;
    }>;
    reserve(input: AgentReservationInput): Promise<AgentReservation>;
    settle(input: {
        toolCallId: string;
        output: unknown;
        actualUsage?: Usage;
    }): Promise<{ usage: Usage }>;
    fail(input: {
        toolCallId: string;
        unknown?: boolean;
        failureCode?: ToolFailureCode;
    }): Promise<void>;
    markInterruptedUnknown(): Promise<number>;
    usage(): Promise<Usage>;
    readAuthorizedCheckpoint(): Promise<AgentCheckpointRef | null>;
    promoteCheckpoint(ref: AgentCheckpointRef): Promise<void>;
    readPages(options?: { allowDeadline?: boolean }): Promise<AgentJson[]>;
}

export class AgentPersistenceError extends Error {
    constructor(
        readonly code:
            | 'BUDGET_EXCEEDED'
            | 'INVALID_TOOL_CALL'
            | 'TOOL_CALL_BUSY'
            | 'INVALID_TOOL_RESULT'
            | 'MODEL_QUOTA_EXCEEDED'
            | 'INVALID_CHECKPOINT',
    ) {
        super(code);
        this.name = 'AgentPersistenceError';
    }
}

const COUNTERS = ['searches', 'pages', 'inputTokens', 'outputTokens'] as const;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const TOOL_SUMMARIES: Record<AgentTool, string> = {
    search: '执行受预算控制的搜索',
    read: '读取已选择的来源网页',
    model: '生成结构化研究内容',
};

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 不接受非 JSON 值、toJSON、循环、超深对象；只保存隔离的 JSON 副本。 */
function jsonValue(value: unknown): AgentJson {
    const seen = new Set<object>();
    const validate = (item: unknown, depth: number): void => {
        if (depth > 64) throw new AgentPersistenceError('INVALID_TOOL_RESULT');
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
        if (typeof item === 'number' && Number.isFinite(item)) return;
        if (typeof item !== 'object' || !item)
            throw new AgentPersistenceError('INVALID_TOOL_RESULT');
        if (seen.has(item)) throw new AgentPersistenceError('INVALID_TOOL_RESULT');
        const prototype = Object.getPrototypeOf(item);
        if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
            throw new AgentPersistenceError('INVALID_TOOL_RESULT');
        if ('toJSON' in item) throw new AgentPersistenceError('INVALID_TOOL_RESULT');
        seen.add(item);
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
            if (descriptor.get || descriptor.set)
                throw new AgentPersistenceError('INVALID_TOOL_RESULT');
            if (descriptor.enumerable) validate(descriptor.value, depth + 1);
        }
        seen.delete(item);
    };
    validate(value, 0);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES)
        throw new AgentPersistenceError('INVALID_TOOL_RESULT');
    return JSON.parse(serialized) as AgentJson;
}

function usage(value: unknown): Usage {
    try {
        return parseContract(UsageSchema, value);
    } catch {
        throw new AgentPersistenceError('INVALID_TOOL_CALL');
    }
}

function reservation(input: AgentReservationInput): Usage {
    if (
        !Object.hasOwn(TOOL_SUMMARIES, input.tool) ||
        typeof input.operationKey !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(input.operationKey)
    )
        throw new AgentPersistenceError('INVALID_TOOL_CALL');
    const reserved = usage(input.reserved);
    const expectedSearches = input.tool === 'search' ? 1 : 0;
    const expectedPages = input.tool === 'read' ? 1 : 0;
    if (
        reserved.searches !== expectedSearches ||
        reserved.pages !== expectedPages ||
        (input.tool !== 'model' && (reserved.inputTokens !== 0 || reserved.outputTokens !== 0)) ||
        (input.tool === 'model' && (reserved.inputTokens < 1 || reserved.outputTokens < 1))
    )
        throw new AgentPersistenceError('INVALID_TOOL_CALL');
    return reserved;
}

function addUsage(current: Usage, reserved: Usage, run: Run): Usage {
    const budget = parseContract(BudgetSchema, run.budgetJson);
    const result: Usage = { ...current, estimated: current.estimated || reserved.estimated };
    const maxima = {
        searches: budget.maxSearches,
        pages: budget.maxPages,
        inputTokens: budget.maxInputTokens,
        outputTokens: budget.maxOutputTokens,
    };
    for (const key of COUNTERS) {
        result[key] = current[key] + reserved[key];
        if (!Number.isSafeInteger(result[key]) || result[key] > maxima[key])
            throw new AgentPersistenceError('BUDGET_EXCEEDED');
    }
    return result;
}

function heldReservation(call: ToolCall): { leaseEpoch: number; reserved: Usage } {
    const value = call.reservedBudget;
    if (
        !record(value) ||
        value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.leaseEpoch) ||
        (value.leaseEpoch as number) < 1
    )
        throw new AgentPersistenceError('INVALID_TOOL_CALL');
    return { leaseEpoch: value.leaseEpoch as number, reserved: usage(value.reserved) };
}

function completedOutput(call: ToolCall): AgentJson {
    const output = call.outputRef;
    if (!record(output) || output.schemaVersion !== 1 || !('result' in output))
        throw new AgentPersistenceError('INVALID_TOOL_RESULT');
    return jsonValue(output.result);
}

function checkpointRef(value: unknown, runId: string, epoch: number): AgentCheckpointRef {
    if (
        !record(value) ||
        !Number.isSafeInteger(value.leaseEpoch) ||
        (value.leaseEpoch as number) < 1 ||
        (value.leaseEpoch as number) > epoch ||
        value.threadId !== `run-${runId}-epoch-${value.leaseEpoch as number}` ||
        value.namespace !== '' ||
        typeof value.checkpointId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(value.checkpointId)
    )
        throw new AgentPersistenceError('INVALID_CHECKPOINT');
    return {
        threadId: value.threadId as string,
        namespace: '',
        checkpointId: value.checkpointId,
        leaseEpoch: value.leaseEpoch as number,
    };
}

/** 仅受信 worker 持有 db/token；Agent 只得到绑定当前 Run 的有限领域方法。 */
export function createAgentRepository(db: DatabaseClient, token: RunLeaseToken): AgentRepository {
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
    return {
        comparison: (options = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                async (tx, run) => ({
                    comparisonScopeHash: run.comparisonScopeHash,
                    baselineRunId: run.baselineRunId,
                    baseline: await loadBaseline(tx, run),
                    feedback: readFeedbackSnapshot(
                        run.feedbackSnapshotJson,
                        run.userId,
                        run.taskId,
                    ),
                }),
            ),
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
                if (input.tool === 'model') {
                    const blocked = await tx.query.runEvents.findFirst({
                        where: and(
                            eq(dbRunEvents.runId, run.id),
                            eq(dbRunEvents.userId, run.userId),
                            eq(dbRunEvents.type, 'tool.failed'),
                            sql`${dbRunEvents.payload}->>'tool' = 'model'`,
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
                const settled: Usage = { ...reserved };
                // 累计 estimated 保守保留；可信单次 usage 仍记录在 ToolCall，unknown 不被洗掉。
                const nextUsage: Usage = { ...current };
                if (actual) {
                    if (actual.searches !== reserved.searches || actual.pages !== reserved.pages)
                        throw new AgentPersistenceError('INVALID_TOOL_RESULT');
                    for (const key of ['inputTokens', 'outputTokens'] as const) {
                        if (actual[key] > reserved[key])
                            throw new AgentPersistenceError('INVALID_TOOL_RESULT');
                        if (!actual.estimated) {
                            settled[key] = actual[key];
                            nextUsage[key] = current[key] - reserved[key] + actual[key];
                            if (!Number.isSafeInteger(nextUsage[key]) || nextUsage[key] < 0)
                                throw new AgentPersistenceError('INVALID_TOOL_RESULT');
                        }
                    }
                    settled.estimated = actual.estimated;
                }
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
                        status: input.unknown === false ? 'failed' : 'unknown',
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
                    },
                });
            });
        },
        markInterruptedUnknown() {
            return fence(async (tx, run, now) => {
                const calls = await tx.query.toolCalls.findMany({
                    where: and(
                        eq(dbToolCalls.userId, run.userId),
                        eq(dbToolCalls.runId, run.id),
                        inArray(dbToolCalls.status, ['reserved', 'running']),
                    ),
                });
                let count = 0;
                for (const call of calls) {
                    if (heldReservation(call).leaseEpoch === token.leaseEpoch) continue;
                    await tx
                        .update(dbToolCalls)
                        .set({ status: 'unknown', finishedAt: now })
                        .where(eq(dbToolCalls.id, call.id))
                        .returning()
                        .then((rows) => requiredDatabaseValue(rows[0]));
                    count += 1;
                }
                return count;
            });
        },
        usage: () => fence(async (_tx, run) => usage(run.usageJson)),
        readAuthorizedCheckpoint: () =>
            fence(async (_tx, run) =>
                run.checkpointRef === null
                    ? null
                    : checkpointRef(run.checkpointRef, run.id, token.leaseEpoch),
            ),
        async promoteCheckpoint(ref) {
            const checked = checkpointRef(ref, token.runId, token.leaseEpoch);
            if (checked.leaseEpoch !== token.leaseEpoch)
                throw new AgentPersistenceError('INVALID_CHECKPOINT');
            return fence(async (tx, run) => {
                await tx
                    .update(dbRuns)
                    .set({ checkpointRef: { ...checked } })
                    .where(eq(dbRuns.id, run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
            });
        },
        readPages: (options = {}) =>
            withRunFence(
                db,
                token,
                options.allowDeadline ? 'deadline_delivery' : 'work',
                async (tx, run) => {
                    const calls = await tx.query.toolCalls.findMany({
                        where: and(
                            eq(dbToolCalls.userId, run.userId),
                            eq(dbToolCalls.runId, run.id),
                            eq(dbToolCalls.tool, 'read'),
                            eq(dbToolCalls.status, 'succeeded'),
                            lte(dbToolCalls.finishedAt, run.deadlineAt!),
                        ),
                        orderBy: [asc(dbToolCalls.operationKey), asc(dbToolCalls.attemptNo)],
                    });
                    return calls.map(completedOutput);
                },
            ),
    };
}
