import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ClaimedRun, RunRepository } from '../src/repo/runs.ts';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { AgentRepository } from '../src/repo/agent.ts';
import { createSessionPersistence } from '../src/service/agent/persistence.ts';
import { RunService, type RunExecutionContext } from '../src/service/runs.ts';
import { RunExecutionError, RunFenceError } from '../src/utils/runs.ts';
import { AgentPersistenceError } from '../src/repo/agent.ts';
import { ConnectorError } from '@scova/connectors';
import { within } from '../src/utils/timeout.ts';

function fixture(duration = 10_000) {
    const now = new Date();
    const claimed = {
        kind: 'claimed',
        token: { runId: 'r', userId: 'u', leaseOwner: 'w', leaseEpoch: 1 },
        run: {
            id: 'r',
            userId: 'u',
            taskId: 't',
            taskVersionId: 'v',
            mode: 'demo',
            startedAt: now,
            deadlineAt: new Date(now.getTime() + duration),
        },
        config: {},
        budget: {},
        usage: {},
        now,
    } as ClaimedRun;
    const repository = {
        claim: vi.fn(async () => claimed),
        renew: vi.fn(async () => 'renewed' as const),
        release: vi.fn(async () => true),
        finish: vi.fn(async () => true),
        emit: vi.fn(async () => {}),
        assertActive: vi.fn(async () => {}),
    } satisfies RunRepository;
    return { repository, claimed };
}
const unresolved = () => new Promise<void>(() => {});
afterEach(() => vi.useRealTimers());

describe('Worker lifecycle failure classification', () => {
    it.each([
        { code: '08006' },
        { code: '57014' },
        new Error('Connection terminated unexpectedly'),
        { code: 'ECONNRESET' },
        new ConnectorError('timeout', 'timeout'),
    ])('leaves recognized retryable failures for fenced recovery: %o', async (error) => {
        const { repository } = fixture();
        const result = await new RunService({
            repository,
            executor: {
                async execute() {
                    throw error;
                },
            },
        }).execute('r');
        expect(result).toBe('ignored');
        expect(repository.finish).not.toHaveBeenCalled();
        expect(repository.release).not.toHaveBeenCalled();
    });
    it.each([
        [new TypeError('bad code'), 'EXECUTOR_FAILED'],
        [new AgentPersistenceError('INVALID_TOOL_CALL'), 'EXECUTOR_FAILED'],
        [new AgentPersistenceError('BUDGET_EXCEEDED'), 'BUDGET_EXCEEDED'],
        [new ConnectorError('model_quota_exceeded', 'quota'), 'MODEL_QUOTA_EXCEEDED'],
        [new ConnectorError('configuration', 'local schema'), 'AGENT_CONFIGURATION_INVALID'],
    ])('terminalizes integrity/code errors with safe failure code', async (error, code) => {
        const { repository, claimed } = fixture();
        await new RunService({
            repository,
            executor: {
                async execute() {
                    throw error;
                },
            },
        }).execute('r');
        expect(repository.finish).toHaveBeenCalledWith(claimed.token, { code });
    });
    it('terminalizes factory initialization faults inside the acquired lease', async () => {
        const { repository, claimed } = fixture();
        await new RunService({
            repository,
            executorFactory() {
                throw new TypeError('bad factory');
            },
        }).execute('r');
        expect(repository.finish).toHaveBeenCalledWith(claimed.token, { code: 'EXECUTOR_FAILED' });
    });
    it('renews while deadline delivery is pending, then stops heartbeat', async () => {
        vi.useFakeTimers();
        const { repository } = fixture(20);
        let release!: () => void;
        const delivered = new Promise<void>((resolve) => {
            release = resolve;
        });
        const onDeadline = vi.fn(async () => delivered);
        const result = new RunService({
            repository,
            leaseMs: 90,
            renewIntervalMs: 10,
            executor: { execute: unresolved, onDeadline },
        }).execute('r');
        await vi.advanceTimersByTimeAsync(60);
        expect(onDeadline).toHaveBeenCalledOnce();
        expect(repository.renew).toHaveBeenCalledWith(expect.anything(), 90, {
            allowDeadline: true,
        });
        release();
        await expect(result).resolves.toBe('processed');
        const calls = vi.mocked(repository.renew).mock.calls.length;
        await vi.advanceTimersByTimeAsync(100);
        expect(repository.renew).toHaveBeenCalledTimes(calls);
    });
    it.each(['stop', 'timeout'] as const)(
        'interrupts stalled deadline delivery on %s and rejects its late domain writes',
        async (ending) => {
            vi.useFakeTimers();
            const { repository } = fixture(20);
            const controller = new AbortController();
            let resume!: () => void;
            const waiting = new Promise<void>((resolve) => {
                resume = resolve;
            });
            const write = vi.fn(async () => {});
            let lateCode: unknown;
            let context: RunExecutionContext | undefined;
            let lateFinished!: () => void;
            const observed = new Promise<void>((resolve) => {
                lateFinished = resolve;
            });
            const service = new RunService({
                repository,
                leaseMs: 90,
                renewIntervalMs: 10,
                deadlineDeliveryTimeoutMs: 50,
                executor: {
                    execute: unresolved,
                    async onDeadline(value) {
                        context = value;
                        const persistence = createSessionPersistence(
                            {} as AgentRepository,
                            {} as PostgresSaver,
                            value,
                        );
                        await waiting;
                        try {
                            await persistence.trackDomain(write, true);
                        } catch (error) {
                            lateCode = (error as { code?: unknown }).code;
                        } finally {
                            lateFinished();
                        }
                    },
                },
            });
            const result = service.execute('r', controller.signal);
            await vi.advanceTimersByTimeAsync(30);
            expect(context?.signal.reason).toBe('deadline');
            expect(context?.controlSignal?.aborted).toBe(false);
            if (ending === 'stop') controller.abort();
            else await vi.advanceTimersByTimeAsync(50);
            await expect(result).resolves.toBe(ending === 'stop' ? 'stopped' : 'ignored');
            expect(context?.controlSignal?.reason).toBe(ending === 'stop' ? 'stop' : 'lost');
            expect(repository.finish).not.toHaveBeenCalled();
            expect(repository.release).toHaveBeenCalledTimes(ending === 'stop' ? 1 : 0);
            const renewals = repository.renew.mock.calls.length;
            resume();
            await observed;
            expect(lateCode).toBe('aborted');
            expect(write).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(100);
            expect(repository.renew).toHaveBeenCalledTimes(renewals);
        },
    );
    it('revokes a queued deadline operation before its persistence microtask starts', async () => {
        const execution = new AbortController(),
            control = new AbortController();
        execution.abort('deadline');
        const persistence = createSessionPersistence(
            {} as AgentRepository,
            {} as PostgresSaver,
            { signal: execution.signal, controlSignal: control.signal } as RunExecutionContext,
        );
        const write = vi.fn(async () => {});
        const pending = persistence.trackDomain(write, true);
        control.abort('stop');
        await expect(pending).rejects.toMatchObject({ code: 'aborted' });
        expect(write).not.toHaveBeenCalled();
    });
    it('routes a delivery fence crossing deadline to deterministic deadline delivery', async () => {
        const { repository } = fixture();
        const onDeadline = vi.fn(async () => {});
        await new RunService({
            repository,
            executor: {
                async execute() {
                    throw new RunFenceError('DEADLINE_EXCEEDED');
                },
                onDeadline,
            },
        }).execute('r');
        expect(onDeadline).toHaveBeenCalledOnce();
    });
    describe.each(['expired', 'running'] as const)('deadline callback from %s claim', (entry) => {
        it.each([
            [new RunFenceError('LEASE_LOST'), 'ignored', undefined],
            [{ code: '08006' }, 'ignored', undefined],
            [new TypeError('bad deadline projection'), 'processed', 'EXECUTOR_FAILED'],
            [new AgentPersistenceError('INVALID_TOOL_CALL'), 'processed', 'EXECUTOR_FAILED'],
            [
                new RunExecutionError('INVALID_DELIVERY_EVIDENCE'),
                'processed',
                'INVALID_DELIVERY_EVIDENCE',
            ],
            [new RunFenceError('DEADLINE_EXCEEDED'), 'processed', 'DEADLINE_EXCEEDED'],
        ])('classifies callback failure %o', async (error, result, code) => {
            const { repository, claimed } = fixture(entry === 'expired' ? -1 : 10_000);
            const execute = vi.fn(async () => {
                throw new RunFenceError('DEADLINE_EXCEEDED');
            });
            const onDeadline = vi.fn(async () => {
                throw error;
            });
            await expect(
                new RunService({ repository, executor: { execute, onDeadline } }).execute('r'),
            ).resolves.toBe(result);
            expect(execute).toHaveBeenCalledTimes(entry === 'expired' ? 0 : 1);
            expect(onDeadline).toHaveBeenCalledOnce();
            if (code) expect(repository.finish).toHaveBeenCalledWith(claimed.token, { code });
            else expect(repository.finish).not.toHaveBeenCalled();
        });
        it('terminalizes a cancellation observed inside the deadline callback', async () => {
            const { repository, claimed } = fixture(entry === 'expired' ? -1 : 10_000);
            let controlSignal: AbortSignal | undefined;
            const onDeadline = vi.fn(async (context: RunExecutionContext) => {
                controlSignal = context.controlSignal;
                throw new RunFenceError('RUN_CANCELED');
            });
            await expect(
                new RunService({
                    repository,
                    executor: {
                        async execute() {
                            throw new RunFenceError('DEADLINE_EXCEEDED');
                        },
                        onDeadline,
                    },
                }).execute('r'),
            ).resolves.toBe('processed');
            expect(onDeadline).toHaveBeenCalledOnce();
            expect(controlSignal?.reason).toBe('canceled');
            // The repository's control fence turns cancellation into a canceled run with no failure.
            expect(repository.finish).toHaveBeenCalledWith(claimed.token, {
                code: 'EXECUTOR_FAILED',
            });
        });
    });
    it('drains before graceful release, preserving recovery handoff', async () => {
        const { repository } = fixture();
        const controller = new AbortController();
        const sequence: string[] = [];
        repository.release = vi.fn(async () => {
            sequence.push('release');
            return true;
        });
        await new RunService({
            repository,
            executor: {
                async execute() {
                    controller.abort();
                    await unresolved();
                },
                async drain() {
                    sequence.push('drain');
                },
            },
        }).execute('r', controller.signal);
        expect(sequence).toEqual(['drain', 'release']);
        expect(repository.finish).not.toHaveBeenCalled();
    });
    it('releases a claim when shutdown arrives during claim', async () => {
        const { repository, claimed } = fixture();
        const controller = new AbortController();
        repository.claim = vi.fn(async () => {
            controller.abort();
            return claimed;
        });
        await expect(new RunService({ repository }).execute('r', controller.signal)).resolves.toBe(
            'stopped',
        );
        expect(repository.release).toHaveBeenCalledWith(claimed.token);
    });
    it('does not execute after claim latency consumed the deadline', async () => {
        vi.useFakeTimers();
        const { repository, claimed } = fixture(20);
        repository.claim = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return claimed;
        });
        const execute = vi.fn(async () => {}),
            onDeadline = vi.fn(async () => {});
        const result = new RunService({ repository, executor: { execute, onDeadline } }).execute(
            'r',
        );
        await vi.advanceTimersByTimeAsync(45);
        await result;
        expect(execute).not.toHaveBeenCalled();
        expect(onDeadline).toHaveBeenCalledOnce();
    });
    it('bounds an uncooperative shutdown promise', async () => {
        vi.useFakeTimers();
        const result = expect(within(unresolved(), 50, 'timeout')).rejects.toThrow('timeout');
        await vi.advanceTimersByTimeAsync(50);
        await result;
    });
});
