import {
    and,
    desc,
    eq,
    inArray,
    lt,
    gte,
    isNull,
    or,
    projectConversationTurns as turns,
    projectResearchDrafts as drafts,
    projectTasks,
    reports,
    type DatabaseExecutor,
} from '@scova/db';
import { firstRow } from '@/utils/database.ts';

export function createProjectConversationStore(
    db: DatabaseExecutor,
    userId: string,
    projectId: string,
) {
    const ownTurn = and(eq(turns.userId, userId), eq(turns.projectId, projectId));
    const ownDraft = and(eq(drafts.userId, userId), eq(drafts.projectId, projectId));
    const visibleReport = and(
        eq(reports.userId, userId),
        inArray(
            reports.taskId,
            db
                .select({ taskId: projectTasks.taskId })
                .from(projectTasks)
                .where(and(eq(projectTasks.userId, userId), eq(projectTasks.projectId, projectId))),
        ),
    );
    return {
        isRunning(id: string, now: Date) {
            return db
                .select({ id: turns.id })
                .from(turns)
                .where(
                    and(
                        ownTurn,
                        eq(turns.id, id),
                        eq(turns.status, 'running'),
                        gte(turns.expiresAt, now),
                    ),
                )
                .then((rows) => rows.length > 0);
        },
        turn(id: string) {
            return db
                .select()
                .from(turns)
                .where(and(ownTurn, eq(turns.id, id)))
                .then(([row]) => row);
        },
        listTurns(limit: number) {
            return db
                .select()
                .from(turns)
                .where(ownTurn)
                .orderBy(desc(turns.createdAt), desc(turns.id))
                .limit(limit);
        },
        listDrafts(ids: string[]) {
            const pending = isNull(drafts.confirmedStart);
            return db
                .select()
                .from(drafts)
                .where(and(ownDraft, ids.length ? or(pending, inArray(drafts.id, ids)) : pending))
                .orderBy(drafts.id);
        },
        expire(now: Date) {
            return db
                .update(turns)
                .set({ status: 'failed', answer: '本轮已超时，可重新发送。' })
                .where(and(ownTurn, eq(turns.status, 'running'), lt(turns.expiresAt, now)));
        },
        claim(id: string, input: typeof turns.$inferInsert.input, now: Date, expiresAt: Date) {
            return db
                .insert(turns)
                .values({
                    id,
                    userId,
                    projectId,
                    input,
                    status: 'running',
                    createdAt: now,
                    expiresAt,
                })
                .onConflictDoNothing()
                .returning()
                .then(([row]) => row);
        },
        finish(
            id: string,
            status: 'completed' | 'failed' | 'canceled',
            answer: string | null,
            draftId?: string,
        ) {
            return db
                .update(turns)
                .set({ status, answer, draftId })
                .where(and(ownTurn, eq(turns.id, id), eq(turns.status, 'running')))
                .returning()
                .then(([row]) => row);
        },
        linkDraft(id: string, draftId: string) {
            return db
                .update(turns)
                .set({ draftId })
                .where(and(ownTurn, eq(turns.id, id)));
        },
        draft(id: string) {
            return db
                .select()
                .from(drafts)
                .where(and(ownDraft, eq(drafts.id, id)))
                .for('update')
                .then(([row]) => row);
        },
        newDraft(config: typeof drafts.$inferInsert.config) {
            return db
                .insert(drafts)
                .values({ userId, projectId, config })
                .returning()
                .then(firstRow);
        },
        updateDraft(id: string, config: typeof drafts.$inferInsert.config, revision: number) {
            return db
                .update(drafts)
                .set({ config, revision })
                .where(and(ownDraft, eq(drafts.id, id)))
                .returning()
                .then(firstRow);
        },
        confirmDraft(id: string, taskId: string, runId: string | null, start: boolean) {
            return db
                .update(drafts)
                .set({
                    confirmedTaskId: taskId,
                    confirmedRunId: runId,
                    confirmedStart: Number(start),
                })
                .where(and(ownDraft, eq(drafts.id, id)));
        },
        async report(id: string) {
            const [report] = await db
                .select({ title: reports.title, summary: reports.summary })
                .from(reports)
                .where(and(visibleReport, eq(reports.id, id)));
            return report;
        },
        async visibleReportIds(ids: string[]) {
            if (!ids.length) return [];
            const rows = await db
                .select({ id: reports.id })
                .from(reports)
                .where(and(visibleReport, inArray(reports.id, ids)));
            return rows.map((row) => row.id);
        },
    };
}
