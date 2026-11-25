import { type Run, type ToolCall } from '@scova/db';
import { BudgetSchema, UsageSchema, parseContract, type Usage } from '@scova/models';
import {
    type AgentTool,
    type AgentJson,
    AgentPersistenceError,
    type AgentReservationInput,
    type AgentCheckpointRef,
} from '@scova/execution/agent';

const COUNTERS = ['searches', 'pages', 'inputTokens', 'outputTokens'] as const;

const MAX_RESULT_BYTES = 2 * 1024 * 1024;

export const TOOL_SUMMARIES: Record<AgentTool, string> = {
    search: '执行受预算控制的搜索',
    read: '读取已选择的来源网页',
    model: '生成结构化研究内容',
};

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 不接受非 JSON 值、toJSON、循环、超深对象；只保存隔离的 JSON 副本。 */
export function jsonValue(value: unknown): AgentJson {
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

export function usage(value: unknown): Usage {
    try {
        return parseContract(UsageSchema, value);
    } catch {
        throw new AgentPersistenceError('INVALID_TOOL_CALL');
    }
}

export function reservation(input: AgentReservationInput): Usage {
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
        (input.tool === 'read' && (reserved.inputTokens !== 0 || reserved.outputTokens !== 0)) ||
        (input.tool === 'search' &&
            (reserved.inputTokens === 0) !== (reserved.outputTokens === 0)) ||
        (input.tool === 'model' && (reserved.inputTokens < 1 || reserved.outputTokens < 1))
    )
        throw new AgentPersistenceError('INVALID_TOOL_CALL');
    return reserved;
}

export function addUsage(current: Usage, reserved: Usage, run: Run): Usage {
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

export function heldReservation(call: ToolCall): { leaseEpoch: number; reserved: Usage } {
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

/** Refund only confirmed token usage; cumulative uncertainty and resource counts stay intact. */
export function reconcileUsage(current: Usage, reserved: Usage, actual?: Usage) {
    const settled = { ...reserved };
    const nextUsage = { ...current };
    if (actual) {
        if (actual.searches !== reserved.searches || actual.pages !== reserved.pages)
            throw new AgentPersistenceError('INVALID_TOOL_RESULT');
        for (const key of ['inputTokens', 'outputTokens'] as const) {
            if (actual[key] > reserved[key]) throw new AgentPersistenceError('INVALID_TOOL_RESULT');
            if (!actual.estimated) {
                settled[key] = actual[key];
                nextUsage[key] = current[key] - reserved[key] + actual[key];
                if (!Number.isSafeInteger(nextUsage[key]) || nextUsage[key] < 0)
                    throw new AgentPersistenceError('INVALID_TOOL_RESULT');
            }
        }
        settled.estimated = actual.estimated;
    }
    return { settled, nextUsage };
}

export function completedOutput(call: ToolCall): AgentJson {
    const output = call.outputRef;
    if (!record(output) || output.schemaVersion !== 1 || !('result' in output))
        throw new AgentPersistenceError('INVALID_TOOL_RESULT');
    return jsonValue(output.result);
}

export function checkpointRef(value: unknown, runId: string, epoch: number): AgentCheckpointRef {
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
