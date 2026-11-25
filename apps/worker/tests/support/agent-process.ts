import {
    createConnectorBundle,
    type ConnectorBundle,
    type StructuredInput,
    type CallContext,
} from '@scova/connectors';
import { createExecutionClient } from '../../src/repo/execution.ts';
import { createAgentSession } from '../../src/service/agent.ts';

// Test-only process fault boundary. Production has no pause or checkpoint bypass hook.
const [phase, runId, boundary = 'search', delivery] = process.argv.slice(2);
if (
    !['crash', 'resume'].includes(phase ?? '') ||
    !['search', 'read'].includes(boundary) ||
    !/^[a-f0-9-]{36}$/.test(runId ?? '')
) {
    throw new Error('Invalid recovery fixture arguments');
}
const execution = createExecutionClient(
    process.env.WORKER_EXECUTION_URL!,
    process.env.WORKER_EXECUTION_TOKEN!,
);
const never = new Promise<void>(() => {});
let boundarySettled = false;
let blocked = false;
async function beforeCheckpointWrite() {
    if (phase !== 'crash' || !boundarySettled) return;
    if (!blocked) {
        blocked = true;
        process.send?.({ type: 'settled-before-checkpoint', pid: process.pid });
    }
    await never;
}
const base = createConnectorBundle();
function count(kind: string) {
    process.send?.({ type: 'connector', kind });
}
const bundle: ConnectorBundle = {
    ...base,
    search: {
        async search(query, context) {
            count('search');
            return base.search.search(query, context);
        },
    },
    reader: {
        async read(url, context) {
            count('read');
            return base.reader.read(url, context);
        },
    },
    model: {
        async generateStructured<T>(input: StructuredInput, context?: CallContext) {
            count('model');
            return base.model.generateStructured<T>(input, context);
        },
    },
};
try {
    await execution.ready();
    const { runs } = execution;
    const claimed = await runs.claim(runId!, `agent-${phase}-${process.pid}`, 60_000);
    if (claimed.kind !== 'claimed') throw new Error(`Cannot claim recovery run: ${claimed.kind}`);
    const { run, token } = claimed;
    const repository = execution.persistence.repository(token);
    const reserve = repository.reserve.bind(repository);
    const settle = repository.settle.bind(repository);
    const boundaryIds = new Set<string>();
    repository.reserve = async (input) => {
        const result = await reserve(input);
        if (input.tool === boundary && result.kind === 'reserved')
            boundaryIds.add(result.toolCallId);
        return result;
    };
    repository.settle = async (input) => {
        const result = await settle(input);
        if (boundaryIds.has(input.toolCallId)) boundarySettled = true;
        return result;
    };
    const saver = execution.persistence.checkpoints(token);
    const put = saver.put.bind(saver);
    const putWrites = saver.putWrites.bind(saver);
    saver.put = async (...args) => {
        await beforeCheckpointWrite();
        return put(...args);
    };
    saver.putWrites = async (...args) => {
        await beforeCheckpointWrite();
        return putWrites(...args);
    };
    const session = createAgentSession({
        repository,
        saver,
        token,
        bundle,
        context: {
            runId: run.id,
            userId: run.userId,
            taskId: run.taskId,
            taskVersionId: run.taskVersionId,
            mode: run.mode,
            config: claimed.config,
            budget: claimed.budget,
            usage: claimed.usage,
            startedAt: run.startedAt!,
            deadlineAt: run.deadlineAt!,
            signal: new AbortController().signal,
            assertActive: () => runs.assertActive(token),
            emit: (event) => runs.emit(token, event),
        },
    });
    const candidate = await session.execute();
    if (delivery === '--deliver') {
        const result = await execution.persistence.deliver!(token, candidate);
        process.send?.({ type: 'report', reportId: result.reportId });
    }
    process.send?.({ type: 'candidate', candidate, pid: process.pid });
} catch (error) {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : 'unknown' });
    console.error(error);
    process.exitCode = 1;
} finally {
    process.disconnect?.();
}
