import { createHash, randomUUID } from 'node:crypto';
import { AgentError, type AgentDependencies } from '@scova/agent-core';
import type { RunProgressEvent } from '@scova/shared/execution/runs';

/** Correlates a logical checkpoint transition with each actual attempt, without exposing either lease or checkpoint. */
export function createGraphStepReporter(
    runId: string,
    emit: (event: RunProgressEvent) => Promise<void>,
): NonNullable<AgentDependencies['onStep']> {
    const started = new Map<string, { started: number; attemptId: string; instanceId: string }>();
    return async (step, phase, { sourceCheckpoint }) => {
        const name = step as Extract<RunProgressEvent, { type: 'step.started' }>['payload']['step'];
        const hash = createHash('sha256')
            .update(JSON.stringify([runId, sourceCheckpoint, step]))
            .digest('hex');
        const instanceId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        if (phase === 'started') {
            const attempt = { started: performance.now(), attemptId: randomUUID(), instanceId };
            started.set(instanceId, attempt);
            await emit({
                type: 'step.started',
                payload: {
                    step: name,
                    execution: { graphVersion: 1, instanceId, attemptId: attempt.attemptId },
                },
            });
        } else {
            const attempt = started.get(instanceId);
            if (!attempt) throw new AgentError('INVALID_STATE', '节点完成前未记录尝试身份');
            await emit({
                type: 'step.completed',
                payload: {
                    step: name,
                    execution: { graphVersion: 1, instanceId, attemptId: attempt.attemptId },
                    durationMs: Math.max(0, Math.floor(performance.now() - attempt.started)),
                },
            });
            started.delete(instanceId);
        }
    };
}
