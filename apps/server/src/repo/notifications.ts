import { Prisma } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import type { NotificationListQuery } from '@scova/contracts';

const include = {
    run: { select: { id: true, taskId: true, mode: true, status: true, failureCode: true } },
} satisfies Prisma.NotificationInclude;
export type StoredNotification = Prisma.NotificationGetPayload<{ include: typeof include }>;
export function createNotificationRepo(services: Pick<ApiServices, 'db'>) {
    return {
        anchor(userId: string, id: string) {
            return services.db().notification.findFirst({ where: { id, userId } });
        },
        async list(
            userId: string,
            filters: Pick<NotificationListQuery, 'kind' | 'unread'>,
            take: number,
            cursor?: { id: string; time: Date },
        ) {
            // ID selection and DTO hydration observe one short database snapshot.
            return services.db().$transaction(
                async (tx) => {
                    const kind = filters.kind
                        ? Prisma.sql`AND kind::text = ${filters.kind}`
                        : Prisma.empty;
                    const read =
                        filters.unread === undefined
                            ? Prisma.empty
                            : filters.unread
                              ? Prisma.sql`AND read_at IS NULL`
                              : Prisma.sql`AND read_at IS NOT NULL`;
                    // PostgreSQL timestamps retain microseconds; JS Dates must never become the keyset boundary.
                    const boundary = cursor
                        ? Prisma.sql`AND (created_at, id) < (
        SELECT created_at, id FROM notifications WHERE user_id = ${userId}::uuid AND id = ${cursor.id}::uuid
      )`
                        : Prisma.empty;
                    const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM notifications WHERE user_id = ${userId}::uuid ${kind} ${read} ${boundary}
        ORDER BY created_at DESC, id DESC LIMIT ${take}
      `;
                    return tx.notification.findMany({
                        where: {
                            userId,
                            ...(filters.kind ? { kind: filters.kind } : {}),
                            ...(filters.unread === undefined
                                ? {}
                                : { readAt: filters.unread ? null : { not: null } }),
                            id: { in: ids.map((row) => row.id) },
                        },
                        include,
                        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    });
                },
                { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
            );
        },
        setRead(userId: string, id: string, read: boolean, now: Date) {
            return services.db().$transaction(async (tx) => {
                await tx.notification.updateMany({
                    where: { id, userId, ...(read ? { readAt: null } : {}) },
                    data: { readAt: read ? now : null },
                });
                return tx.notification.findFirst({ where: { id, userId }, include });
            });
        },
    };
}
