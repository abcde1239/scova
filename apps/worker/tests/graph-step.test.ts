import { describe, expect, it } from 'vite-plus/test';
import { createGraphStepReporter } from '../src/service/agent/graph-step.ts';
import type { RunProgressEvent } from '@scova/execution/runs';

describe('graph step attempt identity', () => {
    it('keeps a checkpoint transition identity across recovery and gives attempts distinct IDs', async () => {
        const events: RunProgressEvent[] = [];
        const emit = async (event: RunProgressEvent) => {
            events.push(event);
        };
        const first = createGraphStepReporter('run-a', emit);
        const recovered = createGraphStepReporter('run-a', emit);
        const source = { sourceCheckpoint: 'private-checkpoint-id' };
        await first('search', 'started', source);
        await recovered('search', 'started', source);
        await recovered('search', 'completed', source);
        const metadata = events.map((event) =>
            'execution' in event.payload ? event.payload.execution : undefined,
        );
        expect(metadata[0]!.instanceId).toBe(metadata[1]!.instanceId);
        expect(metadata[0]!.attemptId).not.toBe(metadata[1]!.attemptId);
        expect(metadata[2]).toEqual(metadata[1]);
        expect(JSON.stringify(events)).not.toContain('private-checkpoint-id');
        await recovered('search', 'started', { sourceCheckpoint: 'next-checkpoint' });
        const next = events.at(-1)!;
        expect(next.type === 'step.started' && next.payload.execution?.instanceId).not.toBe(
            metadata[0]!.instanceId,
        );
    });

    it('rejects a completion without a known matching start', async () => {
        const reporter = createGraphStepReporter('run-a', async () => {});
        await expect(
            reporter('search', 'completed', { sourceCheckpoint: 'missing' }),
        ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });
});
