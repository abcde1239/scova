import {
    and,
    asc,
    desc,
    eq,
    gt,
    projectThreadItems,
    projectThreads,
    sql,
    type DatabaseExecutor,
    type DatabaseTransaction,
} from '@scova/db';

export function createProjectThreadStore(db: DatabaseExecutor, userId: string) {
    function owned(threadId: string) {
        return and(eq(projectThreads.userId, userId), eq(projectThreads.id, threadId));
    }
    return {
        find(threadId: string) {
            return db
                .select()
                .from(projectThreads)
                .where(owned(threadId))
                .then(([row]) => row);
        },
        lock(threadId: string) {
            return db
                .select()
                .from(projectThreads)
                .where(owned(threadId))
                .for('update')
                .then(([row]) => row);
        },
        async itemKind(threadId: string, itemId: string) {
            const [row] = await db
                .select({ kind: projectThreadItems.kind })
                .from(projectThreadItems)
                .where(
                    and(
                        eq(projectThreadItems.userId, userId),
                        eq(projectThreadItems.threadId, threadId),
                        eq(projectThreadItems.id, itemId),
                    ),
                );
            return row?.kind;
        },
        recentItems(threadId: string, limit: number) {
            return db
                .select()
                .from(projectThreadItems)
                .where(
                    and(
                        eq(projectThreadItems.userId, userId),
                        eq(projectThreadItems.threadId, threadId),
                        eq(projectThreadItems.kind, 'message'),
                    ),
                )
                .orderBy(desc(projectThreadItems.seq))
                .limit(limit);
        },
        list(projectId: string) {
            return db
                .select()
                .from(projectThreads)
                .where(
                    and(eq(projectThreads.userId, userId), eq(projectThreads.projectId, projectId)),
                )
                .orderBy(desc(projectThreads.lastActivityAt), desc(projectThreads.id));
        },
        create(projectId: string, title: string, now: Date) {
            return db
                .insert(projectThreads)
                .values({ userId, projectId, title, createdAt: now, lastActivityAt: now })
                .returning()
                .then(([row]) => row);
        },
        update(threadId: string, input: { title?: string; archived?: boolean }, now: Date) {
            return db
                .update(projectThreads)
                .set({
                    title: input.title,
                    archivedAt:
                        input.archived === undefined
                            ? undefined
                            : input.archived
                              ? sql`coalesce(${projectThreads.archivedAt}, ${now.toISOString()}::timestamptz)`
                              : null,
                })
                .where(owned(threadId))
                .returning()
                .then(([row]) => row);
        },
        items(threadId: string, after: number, limit: number) {
            return db
                .select()
                .from(projectThreadItems)
                .where(
                    and(
                        eq(projectThreadItems.userId, userId),
                        eq(projectThreadItems.threadId, threadId),
                        gt(projectThreadItems.seq, after),
                    ),
                )
                .orderBy(asc(projectThreadItems.seq))
                .limit(limit);
        },
    };
}

export async function legacyProjectThread(
    tx: DatabaseExecutor,
    userId: string,
    projectId: string,
    now: Date,
) {
    const [thread] = await tx
        .insert(projectThreads)
        .values({
            userId,
            projectId,
            title: '默认会话',
            isDefault: true,
            createdAt: now,
            lastActivityAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: projectThreads.id });
    if (thread) return thread.id;
    const [existing] = await tx
        .select({ id: projectThreads.id })
        .from(projectThreads)
        .where(
            and(
                eq(projectThreads.userId, userId),
                eq(projectThreads.projectId, projectId),
                eq(projectThreads.isDefault, true),
            ),
        );
    if (!existing) throw new Error('无法定位默认项目会话');
    return existing.id;
}

type Item = Pick<
    typeof projectThreadItems.$inferInsert,
    'id' | 'kind' | 'payload' | 'turnId' | 'status' | 'refs'
>;

export async function appendProjectThreadItems(
    tx: DatabaseTransaction,
    userId: string,
    threadId: string,
    items: Item[],
    now: Date,
) {
    if (items.length === 0) return;
    const owner = and(eq(projectThreads.id, threadId), eq(projectThreads.userId, userId));
    // The row lock remains held across inserts and prevents duplicate or out-of-order cursors.
    const [thread] = await tx
        .select({ id: projectThreads.id })
        .from(projectThreads)
        .where(owner)
        .for('update');
    if (!thread) throw new Error('无法定位条目所属会话');
    const [last] = await tx
        .select({ seq: projectThreadItems.seq })
        .from(projectThreadItems)
        .where(
            and(eq(projectThreadItems.userId, userId), eq(projectThreadItems.threadId, threadId)),
        )
        .orderBy(desc(projectThreadItems.seq))
        .limit(1);
    await tx.insert(projectThreadItems).values(
        items.map((item, index) => ({
            ...item,
            userId,
            threadId,
            seq: (last?.seq ?? 0) + index + 1,
            refs: item.refs ?? [],
            createdAt: now,
        })),
    );
    await tx
        .update(projectThreads)
        .set({
            lastActivityAt: sql`greatest(${projectThreads.lastActivityAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(owner);
}
