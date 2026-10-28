import {
    queryRows,
    and,
    eq,
    inArray,
    isNull,
    isNotNull,
    desc,
    sql,
    notifications,
    type DatabaseExecutor,
    type SQL,
} from '@scova/db';
import type { ApiServices } from '@/app/context.ts';
import type { NotificationListQuery } from '@scova/models';
const withRun = {
    run: { columns: { id: true, taskId: true, mode: true, status: true, failureCode: true } },
} as const;
const readNotification = (db: DatabaseExecutor, where: SQL) =>
    db.query.notifications.findFirst({ where, with: withRun });
export type StoredNotification = NonNullable<Awaited<ReturnType<typeof readNotification>>>;
export function createNotificationRepo(services: Pick<ApiServices, 'db'>) {
    return {
        anchor(userId: string, id: string) {
            return services.db().query.notifications.findFirst({
                where: and(eq(notifications.id, id), eq(notifications.userId, userId)),
            });
        },
        list(
            userId: string,
            filters: Pick<NotificationListQuery, 'kind' | 'unread'>,
            take: number,
            cursor?: { id: string; time: Date },
        ) {
            // ID选择与DTO加载共享同一短快照，保留PostgreSQL微秒时间边界。
            return services.db().transaction(
                async (tx) => {
                    const kind = filters.kind ? sql`AND kind::text=${filters.kind}` : sql.empty();
                    const read =
                        filters.unread === undefined
                            ? sql.empty()
                            : filters.unread
                              ? sql`AND read_at IS NULL`
                              : sql`AND read_at IS NOT NULL`;
                    const boundary = cursor
                        ? sql`AND (created_at,id)<(SELECT created_at,id FROM notifications WHERE user_id=${userId}::uuid AND id=${cursor.id}::uuid)`
                        : sql.empty();
                    const ids = await queryRows<{ id: string }>(
                        tx,
                        sql`SELECT id FROM notifications WHERE user_id=${userId}::uuid ${kind} ${read} ${boundary} ORDER BY created_at DESC,id DESC LIMIT ${take}`,
                    );
                    return tx.query.notifications.findMany({
                        where: and(
                            eq(notifications.userId, userId),
                            filters.kind ? eq(notifications.kind, filters.kind) : undefined,
                            filters.unread === undefined
                                ? undefined
                                : filters.unread
                                  ? isNull(notifications.readAt)
                                  : isNotNull(notifications.readAt),
                            inArray(
                                notifications.id,
                                ids.map((row) => row.id),
                            ),
                        ),
                        with: withRun,
                        orderBy: [desc(notifications.createdAt), desc(notifications.id)],
                    });
                },
                { isolationLevel: 'repeatable read' },
            );
        },
        setRead(userId: string, id: string, read: boolean, now: Date) {
            return services.db().transaction(async (tx) => {
                await tx
                    .update(notifications)
                    .set({ readAt: read ? now : null })
                    .where(
                        and(
                            eq(notifications.id, id),
                            eq(notifications.userId, userId),
                            read ? isNull(notifications.readAt) : undefined,
                        ),
                    );
                return readNotification(
                    tx,
                    and(eq(notifications.id, id), eq(notifications.userId, userId))!,
                );
            });
        },
    };
}
