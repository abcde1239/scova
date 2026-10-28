import {
    NotificationListQuerySchema,
    NotificationListResponseSchema,
    NotificationPatchInputSchema,
    NotificationSchema,
    parseContract,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createNotificationRepo, type StoredNotification } from '@/repo/notifications.ts';
import { ApiError } from '@/utils/errors.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalidCursor = () => new ApiError(400, 'INVALID_CURSOR', '通知游标无效或与筛选范围不一致');
const missing = () => new ApiError(404, 'NOT_FOUND', '资源不存在');
function dto(row: StoredNotification) {
    return parseContract(NotificationSchema, {
        id: row.id,
        runId: row.runId,
        taskId: row.run.taskId,
        reportId: row.reportId,
        kind: row.kind,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        runStatus: row.run.status,
        mode: row.run.mode,
        failureCode: row.run.failureCode,
    });
}
export function createNotificationService(services: ApiServices) {
    const repo = createNotificationRepo(services);
    return {
        async list(userId: string, query: unknown) {
            const page = parseContract(NotificationListQuerySchema, query);
            const scope = JSON.stringify([
                'notifications-v1',
                page.kind ?? null,
                page.unread ?? null,
            ]);
            const take = Math.min(page.limit ?? 50, 100);
            let cursor: { id: string; time: Date } | undefined;
            if (page.cursor) {
                try {
                    const parsed = JSON.parse(
                        Buffer.from(page.cursor, 'base64url').toString('utf8'),
                    );
                    if (
                        parsed.scope !== scope ||
                        !uuid.test(parsed.id) ||
                        typeof parsed.time !== 'string'
                    )
                        throw invalidCursor();
                    const time = new Date(parsed.time);
                    if (!Number.isFinite(time.getTime()) || time.toISOString() !== parsed.time)
                        throw invalidCursor();
                    const anchor = await repo.anchor(userId, parsed.id);
                    if (!anchor || anchor.createdAt.getTime() !== time.getTime())
                        throw invalidCursor();
                    cursor = { id: parsed.id, time };
                } catch {
                    throw invalidCursor();
                }
            }
            const rows = await repo.list(userId, page, take + 1, cursor);
            const last = rows[take - 1];
            return parseContract(NotificationListResponseSchema, {
                items: rows.slice(0, take).map(dto),
                nextCursor:
                    rows.length > take && last
                        ? Buffer.from(
                              JSON.stringify({
                                  id: last.id,
                                  time: last.createdAt.toISOString(),
                                  scope,
                              }),
                          ).toString('base64url')
                        : null,
            });
        },
        async patch(userId: string, id: string, body: unknown) {
            if (!uuid.test(id)) throw missing();
            const { read } = parseContract(NotificationPatchInputSchema, body);
            const row = await repo.setRead(userId, id, read, services.clock());
            if (!row) throw missing();
            return dto(row);
        },
    };
}
