import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { parseContract, RunEventSchema } from '../src/index.ts';
import { reduceRunGraphEvent } from '../src/research/graph-projection.ts';
import {
    runGraphSnapshot,
    RunGraphSnapshotSchema,
    type RunGraphState,
} from '../src/research/graph.ts';
import type { RunEvent } from '../src/research/events.ts';

const runId = randomUUID();
const execution = () => ({
    graphVersion: 1 as const,
    instanceId: randomUUID(),
    attemptId: randomUUID(),
});
function project(
    events: Array<{ type: RunEvent['type']; payload: unknown }>,
    initial: RunGraphState | null = null,
) {
    let state = initial;
    for (const event of events)
        state = reduceRunGraphEvent(
            state,
            parseContract(RunEventSchema, {
                ...event,
                runId,
                schemaVersion: 1,
                eventId: randomUUID(),
                seq: (state?.seq ?? 0) + 1,
                occurredAt: '2026-11-18T00:00:00.000Z',
            }),
        );
    return state!;
}
const queued = {
    type: 'run.queued' as const,
    payload: { status: 'queued', taskVersionId: randomUUID() },
};
const started = (identity: ReturnType<typeof execution>, step = 'search') => ({
    type: 'step.started' as const,
    payload: { step, execution: identity },
});
const completed = (identity: ReturnType<typeof execution>, step = 'search') => ({
    type: 'step.completed' as const,
    payload: { step, execution: identity, durationMs: 5 },
});

describe('durable research graph projection', () => {
    it('keeps repeated node visits as separate instances with static allowed edges', () => {
        const first = execution(),
            second = execution();
        const state = project([queued, started(first), completed(first), started(second)]);
        expect(state).toMatchObject({
            seq: 4,
            graphVersion: 1,
            precision: 'instances',
            historyComplete: true,
        });
        expect(state.instances.map((item) => [item.ordinal, item.attempts[0]!.status])).toEqual([
            [1, 'succeeded'],
            [2, 'running'],
        ]);
        const snapshot = parseContract(RunGraphSnapshotSchema, runGraphSnapshot(state));
        expect(snapshot.nodes.find((node) => node.id === 'search')?.label).toBe('搜索来源');
        expect(snapshot.edges).toContainEqual({ from: 'search', to: 'search' });
    });

    it('separates interrupted recovery attempts under one stable logical instance', () => {
        const first = execution(),
            retry = { ...first, attemptId: randomUUID() };
        const state = project([
            queued,
            started(first),
            { type: 'run.recovering', payload: { status: 'recovering', recoveryCount: 1 } },
            {
                type: 'run.started',
                payload: { status: 'running', startedAt: '2026-11-18T00:00:00Z' },
            },
            started(retry),
            completed(retry),
        ]);
        expect(state.instances).toHaveLength(1);
        expect(
            state.instances[0]!.attempts.map((attempt) => [attempt.number, attempt.status]),
        ).toEqual([
            [1, 'interrupted'],
            [2, 'succeeded'],
        ]);
    });

    it('does not infer node commit from a successful or failed Run terminal event', () => {
        for (const terminal of [
            {
                type: 'run.failed' as const,
                payload: { status: 'failed', code: 'TEST', message: 'failure' },
            },
            {
                type: 'run.completed' as const,
                payload: { status: 'succeeded', outcome: 'new_findings', reportId: randomUUID() },
            },
        ]) {
            const state = project([queued, started(execution()), terminal]);
            expect(state.instances[0]!.attempts[0]!.status).toBe('unknown');
        }
    });

    it('closes running attempts on cancellation without overwriting committed successes', () => {
        const a = execution(),
            b = execution();
        const state = project([
            queued,
            started(a),
            completed(a),
            started(b),
            { type: 'run.canceled', payload: { status: 'canceled', message: 'canceled' } },
        ]);
        expect(state.instances.map((instance) => instance.attempts[0]!.status)).toEqual([
            'succeeded',
            'canceled',
        ]);
    });

    it('keeps legacy starts and completions as counts rather than invented attempts', () => {
        const state = project([
            queued,
            { type: 'step.started', payload: { step: 'search' } },
            { type: 'step.started', payload: { step: 'search' } },
            { type: 'step.completed', payload: { step: 'search', durationMs: 1 } },
        ]);
        expect(state).toMatchObject({
            precision: 'legacy',
            graphVersion: null,
            instances: [],
            legacySteps: [{ step: 'search', started: 2, completed: 1 }],
        });
        expect(runGraphSnapshot(state).nodes).toEqual([]);
    });

    it('is idempotent and never regresses terminal attempt status from duplicate starts', () => {
        const identity = execution();
        const state = project([queued, started(identity), completed(identity), started(identity)]);
        expect(state.instances[0]!.attempts[0]!.status).toBe('succeeded');
        const old = parseContract(RunEventSchema, {
            ...queued,
            runId,
            schemaVersion: 1,
            eventId: randomUUID(),
            seq: 1,
            occurredAt: '2026-11-18T00:00:00Z',
        });
        expect(reduceRunGraphEvent(state, old)).toBe(state);
    });

    it('marks event gaps and completions without starts as incomplete history', () => {
        const identity = execution();
        const orphan = parseContract(RunEventSchema, {
            ...completed(identity),
            runId,
            schemaVersion: 1,
            eventId: randomUUID(),
            seq: 10,
            occurredAt: '2026-11-18T00:00:00Z',
        });
        const state = reduceRunGraphEvent(null, orphan);
        expect(state).toMatchObject({
            seq: 10,
            historyComplete: false,
            precision: 'legacy',
            instances: [],
        });
    });

    it('bounds retained attempts and instances while preserving latest running state', () => {
        const identity = execution();
        let state = project([queued]);
        for (let index = 0; index < 12; index++)
            state = project([started({ ...identity, attemptId: randomUUID() })], state);
        expect(state.instances[0]!.attempts).toHaveLength(8);
        expect(state.instances[0]!.attempts.at(-1)).toMatchObject({
            number: 12,
            status: 'running',
        });
        for (let index = 0; index < 300; index++) state = project([started(execution())], state);
        expect(state.instances).toHaveLength(256);
        expect(state.instances.at(-1)).toMatchObject({
            ordinal: 301,
            attempts: [{ status: 'running' }],
        });
        expect(state.truncated).toBe(true);
        parseContract(RunGraphSnapshotSchema, runGraphSnapshot(state));
    });
});
