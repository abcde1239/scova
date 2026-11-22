import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DatabaseClient, Run } from '@scova/db';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { AgentCandidate } from '@scova/agent-core';
import { createDeliveryService } from '../../server/src/service/execution/delivery.ts';
const state = vi.hoisted(() => ({
    run: undefined as unknown,
    authenticate: vi.fn((_run, _context, proof) => proof.candidate),
}));
vi.mock('../../server/src/repo/execution/delivery.ts', () => ({
    createDeliveryRepository: () => ({
        inRunFence: async (
            _token: unknown,
            _deadline: boolean,
            operation: (tx: unknown, run: unknown, now: Date) => Promise<unknown>,
        ) => operation({}, state.run, new Date()),
    }),
    loadDeliveryInputs: async () => ({ config: {}, context: {}, calls: [] }),
    saveSources: async () => ({}),
    findBaseline: async () => null,
    saveReport: async () => ({ reportId: 'report', reused: false }),
}));
vi.mock('../../server/src/service/execution/delivery-proof.ts', () => ({
    authenticateCandidate: state.authenticate,
    finalizeCoverage: vi.fn(),
    applyBaselineGaps: vi.fn(),
    deliveryOutcome: () => ({ complete: false, changes: [], outcome: 'inconclusive' }),
}));
function fixture(
    ref: unknown = {
        threadId: 'run-r-epoch-1',
        namespace: '',
        checkpointId: 'approved',
        leaseEpoch: 1,
    },
) {
    state.run = { id: 'r', userId: 'u', checkpointRef: ref, deadlineAt: new Date(0) } as Run;
    const database = {
        query: {
            runs: { findFirst: vi.fn(async () => state.run) },
            reports: { findFirst: vi.fn(async () => undefined) },
        },
    } as unknown as DatabaseClient;
    const research = {
        ready: false,
        claims: [{ kind: 'model_answer', text: 'saved answer' }],
        pages: [],
    };
    const saver = {
        getTuple: vi.fn(async () => ({
            checkpoint: { id: 'approved', channel_values: { research } },
        })),
    };
    const service = createDeliveryService(database, saver as unknown as PostgresSaver);
    const token = { runId: 'r', userId: 'u', leaseOwner: 'new-owner', leaseEpoch: 2 };
    const candidate = {
        mode: 'live',
        claims: research.claims,
        pages: [],
    } as unknown as AgentCandidate;
    return { service, token, saver, candidate, research, ref };
}
beforeEach(() => vi.clearAllMocks());
describe('Deadline delivery proof transport', () => {
    it('carries exact promoted research from authorized older epoch into deadline authentication', async () => {
        const f = fixture();
        await f.service.deliver(f.token, f.candidate, true);
        expect(f.saver.getTuple).toHaveBeenCalledWith({
            configurable: {
                thread_id: 'run-r-epoch-1',
                checkpoint_ns: '',
                checkpoint_id: 'approved',
            },
        });
        expect(state.authenticate).toHaveBeenCalledWith(
            state.run,
            {},
            {
                candidate: f.candidate,
                deadline: true,
                checkpointRef: f.ref,
                research: f.research,
            },
            [],
        );
    });
    it('keeps ordinary delivery restricted to current epoch', async () => {
        const f = fixture();
        await expect(f.service.deliver(f.token, f.candidate)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        expect(f.saver.getTuple).not.toHaveBeenCalled();
    });
    it('uses legacy persisted-page proof only when no promoted pointer exists', async () => {
        const f = fixture(null);
        await f.service.deliver(f.token, f.candidate, true);
        expect(f.saver.getTuple).not.toHaveBeenCalled();
        expect(state.authenticate).toHaveBeenCalledWith(
            state.run,
            {},
            { candidate: f.candidate, deadline: true },
            [],
        );
    });
    it('rejects a future epoch pointer instead of downgrading to legacy proof', async () => {
        const f = fixture({
            threadId: 'run-r-epoch-3',
            namespace: '',
            checkpointId: 'approved',
            leaseEpoch: 3,
        });
        await expect(f.service.deliver(f.token, f.candidate, true)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        expect(state.authenticate).not.toHaveBeenCalled();
    });
});
