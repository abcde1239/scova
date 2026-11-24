import {
    and,
    asc,
    eq,
    isNull,
    lte,
    or,
    outbox,
    projectConversationTurns,
    projectResearchDrafts,
    projectTasks,
    projectThreadItems,
    projectThreadRunOrigins,
    projectThreads,
    reports,
    runs,
    sql,
    type DatabaseClient,
    type DatabaseTransaction,
    type Run,
} from '@scova/db';
import { appendProjectThreadItems } from '@/repo/project-threads.ts';
import { isUuid } from '@/utils/security.ts';
import { outboxRetryDelayMilliseconds } from '@/utils/outbox.ts';

export const THREAD_RUN_TERMINAL = 'project_thread.run_terminal';

type Origin = { projectId: string; threadId: string | null };

async function findOrigin(
    tx: DatabaseTransaction,
    { userId, id }: Pick<Run, 'userId' | 'id'>,
): Promise<Origin | undefined> {
    const [origin] = await tx
        .select({
            projectId: projectThreadRunOrigins.projectId,
            threadId: projectThreadRunOrigins.threadId,
        })
        .from(projectThreadRunOrigins)
        .where(
            and(eq(projectThreadRunOrigins.userId, userId), eq(projectThreadRunOrigins.runId, id)),
        );
    if (origin) return origin;

    // The first originating draft response wins over subsequent references to the same draft.
    const [historic] = await tx
        .select({
            projectId: projectResearchDrafts.projectId,
            threadId: projectConversationTurns.threadId,
        })
        .from(projectResearchDrafts)
        .innerJoin(
            projectConversationTurns,
            and(
                eq(projectConversationTurns.userId, projectResearchDrafts.userId),
                eq(projectConversationTurns.projectId, projectResearchDrafts.projectId),
                eq(projectConversationTurns.draftId, projectResearchDrafts.id),
            ),
        )
        .where(
            and(
                eq(projectResearchDrafts.userId, userId),
                eq(projectResearchDrafts.confirmedRunId, id),
            ),
        )
        .orderBy(asc(projectConversationTurns.createdAt), asc(projectConversationTurns.id))
        .limit(1);
    return historic;
}

/** Called within the transaction that records the Run's terminal state. */
export async function enqueueThreadRunResult(
    tx: DatabaseTransaction,
    run: Pick<Run, 'id' | 'userId'>,
    now: Date,
) {
    const origin = await findOrigin(tx, run);
    if (!origin?.threadId) return;
    await tx
        .insert(outbox)
        .values({
            userId: run.userId,
            aggregateId: run.id,
            eventType: THREAD_RUN_TERMINAL,
            dedupeKey: `project-thread-run-${run.id}-terminal`,
            payload: { projectId: origin.projectId, threadId: origin.threadId },
            availableAt: now,
        })
        .onConflictDoNothing({ target: outbox.dedupeKey });
}

function eligibleOutbox(eventType: string, now: Date) {
    return and(
        eq(outbox.eventType, eventType),
        isNull(outbox.sentAt),
        lte(outbox.availableAt, now),
        or(isNull(outbox.leaseExpiresAt), lte(outbox.leaseExpiresAt, now)),
    );
}

async function appendResult(tx: DatabaseTransaction, event: typeof outbox.$inferSelect, now: Date) {
    const { userId, aggregateId: runId, payload } = event;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { projectId, threadId } = payload;
    if (
        typeof projectId !== 'string' ||
        !isUuid(projectId) ||
        typeof threadId !== 'string' ||
        !isUuid(threadId)
    )
        return;

    const [run] = await tx
        .select({
            status: runs.status,
            finishedAt: runs.finishedAt,
            outcome: runs.outcome,
            failureCode: runs.failureCode,
        })
        .from(runs)
        .where(and(eq(runs.userId, userId), eq(runs.id, runId)));
    if (!run?.finishedAt || !['succeeded', 'partial', 'failed', 'canceled'].includes(run.status))
        return;

    // Take the same lock as every other timeline writer before checking for a replay.
    const [thread] = await tx
        .select({ id: projectThreads.id })
        .from(projectThreads)
        .where(
            and(
                eq(projectThreads.userId, userId),
                eq(projectThreads.projectId, projectId),
                eq(projectThreads.id, threadId),
            ),
        )
        .for('update');
    if (!thread) return;
    const [previous] = await tx
        .select({ seq: projectThreadItems.seq })
        .from(projectThreadItems)
        .where(
            and(
                eq(projectThreadItems.userId, userId),
                eq(projectThreadItems.threadId, threadId),
                eq(projectThreadItems.kind, 'run'),
                sql`${projectThreadItems.payload}->>'runId' = ${runId}`,
                sql`${projectThreadItems.payload} ? 'finishedAt'`,
            ),
        )
        .limit(1);
    if (previous) return;

    const [report] = await tx
        .select({ id: reports.id, title: reports.title, completeness: reports.completeness })
        .from(reports)
        .innerJoin(
            projectTasks,
            and(
                eq(projectTasks.userId, reports.userId),
                eq(projectTasks.taskId, reports.taskId),
                eq(projectTasks.projectId, projectId),
            ),
        )
        .where(and(eq(reports.userId, userId), eq(reports.runId, runId)));
    const items: Parameters<typeof appendProjectThreadItems>[3] = [
        {
            kind: 'run',
            status: run.status,
            payload: {
                runId,
                status: run.status,
                finishedAt: run.finishedAt.toISOString(),
                ...(run.outcome ? { outcome: run.outcome } : {}),
                ...(run.failureCode ? { failureCode: run.failureCode } : {}),
            },
        },
    ];
    if (report)
        items.push({
            kind: 'report',
            payload: {
                runId,
                reportId: report.id,
                title: report.title,
                completeness: report.completeness,
            },
            refs: [{ kind: 'report', id: report.id }],
        });
    await appendProjectThreadItems(tx, userId, threadId, items, now);
}

export function createThreadRunResultRepository(db: DatabaseClient) {
    return {
        async deliverNext(now: Date) {
            const result = await db.transaction(async (tx) => {
                const [event] = await tx
                    .select()
                    .from(outbox)
                    .where(eligibleOutbox(THREAD_RUN_TERMINAL, now))
                    .orderBy(asc(outbox.availableAt), asc(outbox.id))
                    .limit(1)
                    .for('update', { skipLocked: true });
                if (!event) return { kind: 'empty' } as const;
                const attempts = event.attempts + 1;
                try {
                    await tx.transaction((savepoint) => appendResult(savepoint, event, now));
                } catch (error) {
                    // The savepoint rolls back all timeline writes. Persist per-event backoff.
                    await tx
                        .update(outbox)
                        .set({
                            attempts,
                            leaseExpiresAt: null,
                            availableAt: new Date(
                                now.getTime() + outboxRetryDelayMilliseconds(attempts),
                            ),
                        })
                        .where(eq(outbox.id, event.id));
                    return { kind: 'retry', error } as const;
                }
                await tx
                    .update(outbox)
                    .set({ attempts, sentAt: now, leaseExpiresAt: null })
                    .where(eq(outbox.id, event.id));
                return { kind: 'delivered' } as const;
            });
            if (result.kind === 'retry') throw result.error;
            return result.kind === 'delivered';
        },
    };
}
