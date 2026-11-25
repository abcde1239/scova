import type { RunnableConfig } from '@langchain/core/runnables';
import { AgentPersistenceError, type AgentCheckpointRef } from '@scova/execution/agent';
import { type RunLeaseToken } from '@scova/execution/runs';
import { type AgentSessionOptions } from '@/service/agent/session.ts';

const thread = (token: RunLeaseToken) => `run-${token.runId}-epoch-${token.leaseEpoch}`;
const configFromRef = (ref: AgentCheckpointRef): RunnableConfig => ({
    configurable: {
        thread_id: ref.threadId,
        checkpoint_ns: ref.namespace,
        checkpoint_id: ref.checkpointId,
    },
});

export function createSessionCheckpoints(
    { repository, saver, token }: Pick<AgentSessionOptions, 'repository' | 'saver' | 'token'>,
    guard: () => Promise<void>,
    readDeadlineTuple = (config: RunnableConfig) => saver.getTuple(config),
) {
    async function promote(config: RunnableConfig) {
        await guard();
        const c = config.configurable;
        if (
            c?.thread_id !== thread(token) ||
            (c.checkpoint_ns ?? '') !== '' ||
            typeof c.checkpoint_id !== 'string'
        )
            throw new AgentPersistenceError('INVALID_CHECKPOINT');
        // Explicit ID is mandatory. A saver may contain unpromoted/late raw checkpoints.
        const tuple = await saver.getTuple(config);
        if (!tuple || tuple.checkpoint.id !== c.checkpoint_id)
            throw new AgentPersistenceError('INVALID_CHECKPOINT');
        await repository.promoteCheckpoint({
            threadId: thread(token),
            namespace: '',
            checkpointId: c.checkpoint_id,
            leaseEpoch: token.leaseEpoch,
        });
    }
    async function openCheckpoint(): Promise<{ config: RunnableConfig; resume: boolean }> {
        await guard();
        await repository.markInterruptedUnknown();
        const ref = await repository.readAuthorizedCheckpoint();
        const current: RunnableConfig = {
            configurable: { thread_id: thread(token), checkpoint_ns: '' },
        };
        if (!ref) return { config: current, resume: false };
        const tuple = await saver.getTuple(configFromRef(ref));
        if (!tuple || tuple.checkpoint.id !== ref.checkpointId)
            throw new AgentPersistenceError('INVALID_CHECKPOINT');
        if (ref.leaseEpoch === token.leaseEpoch)
            return { config: configFromRef(ref), resume: true };
        const fork = await saver.put(
            current,
            tuple.checkpoint,
            { ...tuple.metadata!, source: 'fork' },
            tuple.checkpoint.channel_versions,
        );
        // Pending writes can arrive after promotion from the old epoch. They are not authorized
        // by checkpointRef. Replay unfinished nodes using committed tool results from the ledger.
        await promote(fork);
        return { config: fork, resume: true };
    }

    async function readDeadlineCheckpoint(): Promise<object | null> {
        const ref = await repository.readAuthorizedCheckpoint({ allowDeadline: true });
        if (!ref) return null;
        const tuple = await readDeadlineTuple(configFromRef(ref));
        if (!tuple || tuple.checkpoint.id !== ref.checkpointId)
            throw new AgentPersistenceError('INVALID_CHECKPOINT');
        // Re-check cancellation and ownership after saver I/O, without mutating/forking the graph.
        await repository.readAuthorizedCheckpoint({ allowDeadline: true });
        const research = tuple.checkpoint.channel_values.research;
        if (!research || typeof research !== 'object')
            throw new AgentPersistenceError('INVALID_CHECKPOINT');
        return research;
    }
    return { promote, openCheckpoint, readDeadlineCheckpoint };
}
