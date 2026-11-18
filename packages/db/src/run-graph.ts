import { and, eq } from 'drizzle-orm';
import { reduceRunGraphEvent, type RunEvent } from '@scova/models';
import type { DatabaseExecutor } from './client.ts';
import { runGraphSnapshots } from './schema/run-graph.ts';

/** Caller holds the Run lock; event and projection must commit in the same transaction. */
export async function persistRunGraphEvent(
    database: DatabaseExecutor,
    userId: string,
    event: RunEvent,
): Promise<void> {
    const [previous] = await database
        .select()
        .from(runGraphSnapshots)
        .where(and(eq(runGraphSnapshots.runId, event.runId), eq(runGraphSnapshots.userId, userId)));
    const state = reduceRunGraphEvent(previous?.stateJson ?? null, event);
    // Only the current producer can stamp a new Run's topology. Replaying an old queued
    // event in the HTTP legacy fallback must not retroactively assert this version.
    if (!previous && event.type === 'run.queued' && event.seq === 1) state.graphVersion = 1;
    if (previous && state.seq === previous.seq) return;
    await database
        .insert(runGraphSnapshots)
        .values({ runId: event.runId, userId, seq: state.seq, stateJson: state })
        .onConflictDoUpdate({
            target: runGraphSnapshots.runId,
            set: { seq: state.seq, stateJson: state },
        });
}
