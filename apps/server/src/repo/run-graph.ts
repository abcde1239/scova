import { and, eq, desc, gt, type DatabaseClient } from '@scova/db';
import { runs, runEvents, runGraphSnapshots } from '@scova/db';
import { ApiError } from '@/utils/errors.ts';

/** A short repeatable-read snapshot, never held open while sending HTTP or SSE. */
export function createRunGraphRepository(database: () => DatabaseClient) {
    return {
        read(userId: string, runId: string) {
            return database().transaction(
                async (tx) => {
                    const run = await tx.query.runs.findFirst({
                        where: and(eq(runs.id, runId), eq(runs.userId, userId)),
                        columns: { id: true, status: true },
                    });
                    if (!run) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
                    const [projection] = await tx
                        .select()
                        .from(runGraphSnapshots)
                        .where(
                            and(
                                eq(runGraphSnapshots.runId, runId),
                                eq(runGraphSnapshots.userId, userId),
                            ),
                        );
                    // Legacy/incomplete projections replay only a bounded tail. New snapshots never
                    // depend on retained events, so cursor expiry cannot erase known node history.
                    const tail = await tx
                        .select()
                        .from(runEvents)
                        .where(
                            and(
                                eq(runEvents.runId, runId),
                                eq(runEvents.userId, userId),
                                ...(projection ? [gt(runEvents.seq, projection.seq)] : []),
                            ),
                        )
                        .orderBy(desc(runEvents.seq))
                        .limit(5001);
                    return {
                        run,
                        projection: projection?.stateJson ?? null,
                        events: tail.slice(0, 5000).reverse(),
                        truncated: tail.length > 5000,
                    };
                },
                { isolationLevel: 'repeatable read' },
            );
        },
    };
}
