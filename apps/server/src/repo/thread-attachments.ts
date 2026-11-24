import {
    and,
    asc,
    eq,
    inArray,
    isNotNull,
    isNull,
    lte,
    or,
    projectThreadAttachments as attachments,
    projectThreads,
    type DatabaseExecutor,
} from '@scova/db';

type NewAttachment = typeof attachments.$inferInsert;

export function createThreadAttachmentRepo(db: DatabaseExecutor) {
    function collectible(cutoff: Date) {
        return and(
            lte(attachments.updatedAt, cutoff),
            or(isNull(attachments.readyAt), isNull(attachments.threadId)),
        );
    }

    return {
        async reserve(input: NewAttachment & { threadId: string }) {
            const [row] = await db
                .insert(attachments)
                .values(input)
                .onConflictDoUpdate({
                    target: [attachments.threadId, attachments.digest],
                    set: { updatedAt: input.updatedAt },
                })
                .returning();
            return row!;
        },
        async lock(id: string, threadId: string) {
            const [row] = await db
                .select()
                .from(attachments)
                .where(and(eq(attachments.id, id), eq(attachments.threadId, threadId)))
                .for('update');
            return row;
        },
        async markReady(id: string, now: Date) {
            const [row] = await db
                .update(attachments)
                .set({ readyAt: now, updatedAt: now })
                .where(eq(attachments.id, id))
                .returning();
            return row!;
        },
        async findReady(userId: string, threadId: string, ids: string[]) {
            if (!ids.length) return [];
            const rows = await db
                .select({ attachment: attachments })
                .from(attachments)
                .innerJoin(projectThreads, eq(attachments.threadId, projectThreads.id))
                .where(
                    and(
                        eq(projectThreads.userId, userId),
                        eq(projectThreads.id, threadId),
                        inArray(attachments.id, ids),
                        isNotNull(attachments.readyAt),
                    ),
                );
            return rows.map(({ attachment }) => attachment);
        },
        candidates(cutoff: Date, limit: number) {
            return db
                .select({ id: attachments.id })
                .from(attachments)
                .where(collectible(cutoff))
                .orderBy(asc(attachments.updatedAt))
                .limit(limit);
        },
        async lockCandidate(id: string, cutoff: Date) {
            const [row] = await db
                .select()
                .from(attachments)
                .where(and(eq(attachments.id, id), collectible(cutoff)))
                .for('update', { skipLocked: true });
            return row;
        },
        async remove(id: string) {
            await db.delete(attachments).where(eq(attachments.id, id));
        },
        async postponeCleanup(id: string, now: Date) {
            await db.update(attachments).set({ updatedAt: now }).where(eq(attachments.id, id));
        },
    };
}
