import {
    queryRows,
    and,
    eq,
    isNull,
    asc,
    count,
    sql,
    sources,
    runs,
    runSources,
    tasks,
    claims,
    feedback,
    type DatabaseExecutor,
} from '@scova/db';
import type { ApiServices } from '@/app/context.ts';
import type { FeedbackInput } from '@scova/models';
import { firstRow } from '@/utils/database.ts';

function store(tx: DatabaseExecutor) {
    return {
        lockTask(userId: string, taskId: string) {
            return queryRows<{ id: string }>(
                tx,
                sql`SELECT id FROM tasks WHERE id=${taskId}::uuid AND user_id=${userId}::uuid FOR NO KEY UPDATE`,
            );
        },
        find(userId: string, id: string) {
            return tx.query.feedback.findFirst({
                where: and(eq(feedback.id, id), eq(feedback.userId, userId)),
            });
        },
        async target(userId: string, input: FeedbackInput) {
            if (input.sourceId) {
                const rows = await tx
                    .select({ id: sources.id })
                    .from(sources)
                    .innerJoin(
                        runSources,
                        and(
                            eq(runSources.sourceId, sources.id),
                            eq(runSources.userId, sources.userId),
                        ),
                    )
                    .innerJoin(
                        runs,
                        and(eq(runs.id, runSources.runId), eq(runs.userId, runSources.userId)),
                    )
                    .where(
                        and(
                            eq(sources.id, input.sourceId),
                            eq(sources.userId, userId),
                            eq(runs.taskId, input.taskId),
                            eq(runs.userId, userId),
                        ),
                    )
                    .limit(1);
                return rows[0];
            }
            return tx.query.claims.findFirst({
                where: and(
                    eq(claims.id, input.claimId!),
                    eq(claims.userId, userId),
                    eq(claims.taskId, input.taskId),
                ),
                columns: { id: true },
            });
        },
        existing(userId: string, input: FeedbackInput) {
            return tx.query.feedback.findFirst({
                where: and(
                    eq(feedback.userId, userId),
                    eq(feedback.taskId, input.taskId),
                    input.sourceId
                        ? eq(feedback.sourceId, input.sourceId)
                        : isNull(feedback.sourceId),
                    input.claimId ? eq(feedback.claimId, input.claimId) : isNull(feedback.claimId),
                ),
            });
        },
        count(userId: string, taskId: string) {
            return tx
                .select({ value: count() })
                .from(feedback)
                .where(
                    and(
                        eq(feedback.userId, userId),
                        eq(feedback.taskId, taskId),
                        eq(feedback.active, true),
                    ),
                )
                .then(([row]) => row!.value);
        },
        create(userId: string, input: FeedbackInput) {
            return tx
                .insert(feedback)
                .values({
                    userId,
                    taskId: input.taskId,
                    sourceId: input.sourceId ?? null,
                    claimId: input.claimId ?? null,
                    kind: input.kind,
                })
                .returning()
                .then(firstRow);
        },
        update(id: string, data: Partial<typeof feedback.$inferInsert>) {
            return tx
                .update(feedback)
                .set(data)
                .where(eq(feedback.id, id))
                .returning()
                .then(firstRow);
        },
    };
}
export function createFeedbackRepo(services: Pick<ApiServices, 'db'>) {
    return {
        find(userId: string, id: string) {
            return services.db().query.feedback.findFirst({
                where: and(eq(feedback.id, id), eq(feedback.userId, userId)),
            });
        },
        task(userId: string, id: string) {
            return services.db().query.tasks.findFirst({
                where: and(eq(tasks.id, id), eq(tasks.userId, userId)),
                columns: { id: true },
            });
        },
        list(userId: string, taskId: string) {
            return services.db().query.feedback.findMany({
                where: and(
                    eq(feedback.userId, userId),
                    eq(feedback.taskId, taskId),
                    eq(feedback.active, true),
                ),
                orderBy: [asc(feedback.id)],
                limit: 200,
            });
        },
        transaction<T>(work: (value: ReturnType<typeof store>) => Promise<T>) {
            return services.db().transaction((tx) => work(store(tx)));
        },
    };
}
