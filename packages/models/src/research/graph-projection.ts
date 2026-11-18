import type { RunEvent } from './events.ts';
import type { RunGraphAttempt, RunGraphSnapshot, RunGraphState } from './graph.ts';

/** Bounded durable projection; missing completions remain uncertain, even for a successful Run. */
export function reduceRunGraphEvent(
    previous: RunGraphState | null,
    event: RunEvent,
): RunGraphState {
    if (previous && event.seq <= previous.seq) return previous;
    const state: RunGraphState = previous
        ? structuredClone(previous)
        : {
              runId: event.runId,
              graphVersion: null,
              precision: 'instances',
              seq: 0,
              runStatus: 'queued',
              instances: [],
              legacySteps: [],
              historyComplete: event.seq === 1 && event.type === 'run.queued',
              truncated: false,
          };
    if (state.runId !== event.runId) throw new Error('运行图事件不属于同一执行');
    if (event.seq !== state.seq + 1) {
        state.historyComplete = false;
        state.precision = 'legacy';
    }
    state.seq = event.seq;
    const closeRunning = (status: RunGraphAttempt['status']) => {
        for (const instance of state.instances) {
            for (const attempt of instance.attempts) {
                if (attempt.status === 'running') {
                    attempt.status = status;
                    attempt.finishedAt = event.occurredAt;
                }
            }
        }
    };
    switch (event.type) {
        case 'run.queued':
        case 'run.started':
        case 'run.recovering':
        case 'run.completed':
        case 'run.failed':
        case 'run.canceled': {
            state.runStatus = event.payload.status;
            if (event.type === 'run.started' || event.type === 'run.recovering')
                closeRunning('interrupted');
            else if (event.type === 'run.canceled') closeRunning('canceled');
            else if (event.type === 'run.completed' || event.type === 'run.failed')
                closeRunning('unknown');
            break;
        }
        case 'step.started':
        case 'step.completed': {
            const { step, execution } = event.payload;
            if (!execution) {
                state.precision = 'legacy';
                let count = state.legacySteps.find((item) => item.step === step);
                if (!count) {
                    count = { step, started: 0, completed: 0 };
                    state.legacySteps.push(count);
                }
                if (event.type === 'step.started') count.started++;
                else count.completed++;
                break;
            }
            state.graphVersion = execution.graphVersion;
            let instance = state.instances.find((item) => item.instanceId === execution.instanceId);
            if (!instance) {
                if (event.type === 'step.completed') {
                    // A pruned/missing start cannot be reconstructed from a completion timestamp.
                    state.historyComplete = false;
                    state.precision = 'legacy';
                    break;
                }
                instance = {
                    instanceId: execution.instanceId,
                    step,
                    ordinal: (state.instances.at(-1)?.ordinal ?? 0) + 1,
                    attempts: [],
                };
                state.instances.push(instance);
            }
            if (instance.step !== step) throw new Error('运行图节点身份与步骤不一致');
            let attempt = instance.attempts.find((item) => item.attemptId === execution.attemptId);
            if (event.type === 'step.started') {
                if (attempt) break;
                // A new start proves only that the preceding callback ended; it does not prove commit.
                closeRunning('unknown');
                attempt = {
                    attemptId: execution.attemptId,
                    number: (instance.attempts.at(-1)?.number ?? 0) + 1,
                    status: 'running',
                    startedAt: event.occurredAt,
                    finishedAt: null,
                    durationMs: null,
                };
                instance.attempts.push(attempt);
            } else if (attempt?.status === 'running') {
                attempt.status = 'succeeded';
                attempt.finishedAt = event.occurredAt;
                attempt.durationMs = event.payload.durationMs;
            } else if (!attempt) {
                state.historyComplete = false;
                state.precision = 'legacy';
            }
            if (instance.attempts.length > 8) {
                instance.attempts.splice(0, instance.attempts.length - 8);
                state.truncated = true;
            }
            if (state.instances.length > 256) {
                // Execution is serial; new starts close the previous attempt before trimming.
                state.instances.splice(0, state.instances.length - 256);
                state.truncated = true;
            }
            break;
        }
    }
    if (!state.historyComplete) state.precision = 'legacy';
    return state;
}

/** Run row is authoritative for cancel_requested, which intentionally has no progress event. */
export function reconcileRunGraphStatus(
    snapshot: RunGraphSnapshot,
    runStatus: RunGraphSnapshot['runStatus'],
): RunGraphSnapshot {
    return { ...snapshot, runStatus };
}
