import {
    and,
    desc,
    eq,
    inArray,
    isNotNull,
    isNull,
    notifications,
    sql,
    workflowNotifications,
    type DatabaseExecutor,
} from '@scova/db';
import type { NotificationListQuery } from '@scova/models';
import type { ApiServices } from '@/app/services';

const researchRun = {
    run: { columns: { taskId: true, mode: true, status: true, failureCode: true } },
} as const;
const researchIdentity = (userId: string, id: string) =>
    and(eq(notifications.userId, userId), eq(notifications.id, id));
const workflowIdentity = (userId: string, id: string) =>
    and(eq(workflowNotifications.userId, userId), eq(workflowNotifications.id, id));
const readResearch = (db: DatabaseExecutor, userId: string, id: string) =>
    db.query.notifications.findFirst({ where: researchIdentity(userId, id), with: researchRun });
const readWorkflow = (db: DatabaseExecutor, userId: string, id: string) =>
    db.query.workflowNotifications.findFirst({
        where: workflowIdentity(userId, id),
    });
export type StoredNotification = NonNullable<
    Awaited<ReturnType<typeof readResearch | typeof readWorkflow>>
>;
type Source = 'research' | 'workflow';
type Cursor = { id: string; source: Source };

export function createNotificationRepo(services: Pick<ApiServices, 'db'>) {
    return {
        async anchor(userId: string, id: string, source?: Source) {
            const db = services.db();
            if (source !== 'workflow') {
                const research = await db.query.notifications.findFirst({
                    where: researchIdentity(userId, id),
                    columns: { createdAt: true },
                });
                if (research) return { ...research, source: 'research' as const };
            }
            if (source === 'research') return;
            const workflow = await db.query.workflowNotifications.findFirst({
                where: workflowIdentity(userId, id),
                columns: { createdAt: true },
            });
            if (workflow) return { ...workflow, source: 'workflow' as const };
        },
        list(
            userId: string,
            filters: Pick<NotificationListQuery, 'kind' | 'unread'>,
            take: number,
            cursor?: Cursor,
        ) {
            return services.db().transaction(
                async (tx) => {
                    const read =
                        filters.unread === undefined
                            ? undefined
                            : filters.unread
                              ? isNull
                              : isNotNull;
                    const anchorTable =
                        cursor?.source === 'workflow' ? workflowNotifications : notifications;
                    // Use the stored timestamp for the keyset boundary to preserve microseconds.
                    const boundary = (table: typeof notifications | typeof workflowNotifications) =>
                        cursor &&
                        sql`(${table.createdAt}, ${table.id}) < (
                            SELECT ${anchorTable.createdAt}, ${anchorTable.id} FROM ${anchorTable}
                            WHERE ${anchorTable.userId} = ${userId} AND ${anchorTable.id} = ${cursor.id}
                        )`;
                    const research = tx
                        .select({
                            id: notifications.id,
                            createdAt: notifications.createdAt,
                            source: sql<Source>`'research'`.as('source'),
                        })
                        .from(notifications)
                        .where(
                            and(
                                eq(notifications.userId, userId),
                                filters.kind && filters.kind !== 'workflow'
                                    ? eq(notifications.kind, filters.kind)
                                    : undefined,
                                read?.(notifications.readAt),
                                boundary(notifications),
                            ),
                        );
                    const workflow = tx
                        .select({
                            id: workflowNotifications.id,
                            createdAt: workflowNotifications.createdAt,
                            source: sql<Source>`'workflow'`.as('source'),
                        })
                        .from(workflowNotifications)
                        .where(
                            and(
                                eq(workflowNotifications.userId, userId),
                                read?.(workflowNotifications.readAt),
                                boundary(workflowNotifications),
                            ),
                        );
                    const candidates = (
                        filters.kind === 'workflow'
                            ? workflow
                            : filters.kind
                              ? research
                              : research.unionAll(workflow)
                    ).as('candidates');
                    const page = await tx
                        .select({ id: candidates.id, source: candidates.source })
                        .from(candidates)
                        .orderBy(desc(candidates.createdAt), desc(candidates.id))
                        .limit(take);
                    const researchIds = page
                        .filter((row) => row.source === 'research')
                        .map((row) => row.id);
                    const workflowIds = page
                        .filter((row) => row.source === 'workflow')
                        .map((row) => row.id);
                    const researchRows = researchIds.length
                        ? await tx.query.notifications.findMany({
                              where: and(
                                  eq(notifications.userId, userId),
                                  inArray(notifications.id, researchIds),
                              ),
                              with: researchRun,
                          })
                        : [];
                    const workflowRows = workflowIds.length
                        ? await tx.query.workflowNotifications.findMany({
                              where: and(
                                  eq(workflowNotifications.userId, userId),
                                  inArray(workflowNotifications.id, workflowIds),
                              ),
                          })
                        : [];
                    const researchById = new Map(researchRows.map((row) => [row.id, row]));
                    const workflowById = new Map(workflowRows.map((row) => [row.id, row]));
                    return page.map(
                        ({ id, source }): StoredNotification =>
                            (source === 'research' ? researchById.get(id) : workflowById.get(id))!,
                    );
                },
                { isolationLevel: 'repeatable read' },
            );
        },
        setRead(userId: string, id: string, read: boolean, now: Date) {
            return services.db().transaction(async (tx) => {
                const readAt = read ? now : null;
                await tx
                    .update(notifications)
                    .set({ readAt })
                    .where(
                        and(
                            researchIdentity(userId, id),
                            read ? isNull(notifications.readAt) : undefined,
                        ),
                    );
                const research = await readResearch(tx, userId, id);
                if (research) return research;
                await tx
                    .update(workflowNotifications)
                    .set({ readAt })
                    .where(
                        and(
                            workflowIdentity(userId, id),
                            read ? isNull(workflowNotifications.readAt) : undefined,
                        ),
                    );
                return readWorkflow(tx, userId, id);
            });
        },
    };
}
