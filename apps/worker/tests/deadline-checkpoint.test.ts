import { describe, expect, it, vi } from 'vite-plus/test';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createConnectorBundle } from '@scova/connectors';
import { createAgentSession } from '../src/service/agent/session.ts';
import type { AgentRepository } from '../../server/src/repo/execution/agent.ts';
import type { RunExecutionContext } from '../src/service/runs.ts';
import { RunFenceError } from '@scova/shared/execution/runs';
const projection = vi.hoisted(() => vi.fn((_context, state) => ({ claims: state.claims })));
vi.mock('@scova/agent-core', async (original) => ({
    ...(await original<typeof import('@scova/agent-core')>()),
    candidateFromCheckpoint: projection,
}));
function fixture(checkpointId = 'approved') {
    const controller = new AbortController();
    controller.abort('deadline');
    const ref = {
        threadId: 'run-r-epoch-1',
        namespace: '' as const,
        checkpointId: 'approved',
        leaseEpoch: 1,
    };
    const research = {
        pagePolicy: 1,
        ready: false,
        pages: [],
        claims: [{ kind: 'model_answer', text: '已保存回答' }],
    };
    const repository = {
        comparison: vi.fn(async () => ({})),
        readPages: vi.fn(async () => []),
        readAuthorizedCheckpoint: vi.fn(async () => ref),
        readCheckpointPages: vi.fn(async () => []),
        promoteCheckpoint: vi.fn(),
        markInterruptedUnknown: vi.fn(),
    };
    const saver = {
        getTuple: vi.fn(async () => ({
            checkpoint: { id: checkpointId, channel_values: { research } },
            pendingWrites: [['foreign-task', 'research', { claims: ['late unpromoted'] }]],
        })),
        put: vi.fn(),
        putWrites: vi.fn(),
    };
    const base = createConnectorBundle();
    const search = vi.fn(),
        read = vi.fn(),
        model = vi.fn();
    const session = createAgentSession({
        repository: repository as unknown as AgentRepository,
        saver: saver as unknown as PostgresSaver,
        token: {
            runId: 'r',
            userId: 'u',
            leaseOwner: 'w',
            leaseEpoch: 1,
        },
        context: { signal: controller.signal, usage: {}, mode: 'demo' } as RunExecutionContext,
        bundle: {
            ...base,
            search: { search },
            reader: { read },
            model: { generateStructured: model },
        },
    });
    return { session, repository, saver, research, search, read, model };
}
describe('Worker authorized deadline projection', () => {
    it('retains model-only promoted claims, reads exact ID and never invokes providers or writes', async () => {
        const f = fixture();
        expect(await f.session.partial()).toEqual({ claims: f.research.claims });
        expect(f.saver.getTuple).toHaveBeenCalledWith({
            configurable: {
                thread_id: 'run-r-epoch-1',
                checkpoint_ns: '',
                checkpoint_id: 'approved',
            },
        });
        expect(projection).toHaveBeenCalledWith(expect.anything(), f.research, 'deadline');
        expect(f.repository.readAuthorizedCheckpoint).toHaveBeenCalledTimes(2);
        for (const fn of [
            f.search,
            f.read,
            f.model,
            f.saver.put,
            f.saver.putWrites,
            f.repository.promoteCheckpoint,
            f.repository.markInterruptedUnknown,
            f.repository.readPages,
        ])
            expect(fn).not.toHaveBeenCalled();
    });
    it('does not downgrade a missing authorized checkpoint to raw-page fallback', async () => {
        const f = fixture('late-unapproved');
        await expect(f.session.partial()).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
        expect(f.repository.readPages).not.toHaveBeenCalled();
    });
    it('rechecks cancellation after saver I/O before projecting any data', async () => {
        const f = fixture();
        vi.mocked(f.repository.readAuthorizedCheckpoint)
            .mockResolvedValueOnce({
                threadId: 'run-r-epoch-1',
                namespace: '',
                checkpointId: 'approved',
                leaseEpoch: 1,
            })
            .mockRejectedValueOnce(new RunFenceError('RUN_CANCELED'));
        await expect(f.session.partial()).rejects.toMatchObject({ code: 'RUN_CANCELED' });
        expect(f.saver.getTuple).toHaveBeenCalledOnce();
    });
});
