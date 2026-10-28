import {
    queryRows,
    and,
    eq,
    inArray,
    isNull,
    isNotNull,
    asc,
    desc,
    sql,
    reports,
    tasks,
    inboxItems,
    claims,
    changeRecords,
    type DatabaseExecutor,
    type SQL,
} from '@scova/db';
import type { ApiServices } from '@/app/services';

const summaryWith = { run: true } as const;
const evidenceWith = {
    observation: {
        with: {
            source: true,
            snapshot: {
                columns: {
                    id: true,
                    userId: true,
                    sourceId: true,
                    title: true,
                    contentHash: true,
                    extractorVersion: true,
                    publishedAt: true,
                    metadataJson: true,
                },
            },
        },
    },
} as const;
const detailWith = {
    ...summaryWith,
    baseline: true,
    claims: {
        orderBy: asc(claims.order),
        with: { citations: { with: { evidence: { with: evidenceWith } } } },
    },
    changes: {
        orderBy: asc(changeRecords.id),
        with: { citations: { with: { evidence: { with: evidenceWith } } } },
    },
} as const;
const inboxWith = { report: { with: summaryWith } } as const;
type Cursor = { id: string; time: Date };
const readSummary = (db: DatabaseExecutor, where: SQL) =>
    db.query.reports.findFirst({ where, with: summaryWith });
const readReport = (db: DatabaseExecutor, where: SQL) =>
    db.query.reports.findFirst({ where, with: detailWith });
const readInbox = (db: DatabaseExecutor, where: SQL) =>
    db.query.inboxItems.findFirst({ where, with: inboxWith });
export type StoredReportSummary = NonNullable<Awaited<ReturnType<typeof readSummary>>>;
export type StoredReport = NonNullable<Awaited<ReturnType<typeof readReport>>>;
export type StoredEvidence = StoredReport['claims'][number]['citations'][number]['evidence'];
export type StoredInboxItem = NonNullable<Awaited<ReturnType<typeof readInbox>>>;

/** 所有查询与写入均绑定会话 owner；完整正文不进入报告读取查询。 */
export function createReportRepo(services: Pick<ApiServices, 'db'>) {
    return {
        findTask(userId: string, id: string) {
            return services.db().query.tasks.findFirst({
                where: and(eq(tasks.id, id), eq(tasks.userId, userId)),
                columns: { id: true },
            });
        },
        findReportAnchor(userId: string, id: string) {
            return services.db().query.reports.findFirst({
                where: and(eq(reports.id, id), eq(reports.userId, userId)),
                columns: { id: true, taskId: true, publishedAt: true },
            });
        },
        async listReports(userId: string, take: number, taskId?: string, cursor?: Cursor) {
            const task = taskId ? sql`AND task_id=${taskId}::uuid` : sql.empty();
            const boundary = cursor
                ? sql`AND (published_at,id)<(SELECT published_at,id FROM reports WHERE user_id=${userId}::uuid AND id=${cursor.id}::uuid)`
                : sql.empty();
            const ids = await queryRows<{ id: string }>(
                services.db(),
                sql`SELECT id FROM reports WHERE user_id=${userId}::uuid ${task} ${boundary} ORDER BY published_at DESC,id DESC LIMIT ${take}`,
            );
            return services.db().query.reports.findMany({
                where: and(
                    eq(reports.userId, userId),
                    inArray(
                        reports.id,
                        ids.map((row) => row.id),
                    ),
                ),
                with: summaryWith,
                orderBy: [desc(reports.publishedAt), desc(reports.id)],
            });
        },
        findReport(userId: string, id: string) {
            return readReport(services.db(), and(eq(reports.id, id), eq(reports.userId, userId))!);
        },
        findInboxAnchor(userId: string, id: string) {
            return services.db().query.inboxItems.findFirst({
                where: and(eq(inboxItems.id, id), eq(inboxItems.userId, userId)),
                columns: { id: true, createdAt: true },
            });
        },
        async listInbox(userId: string, take: number, unread?: boolean, cursor?: Cursor) {
            return services.db().transaction(
                async (tx) => {
                    const read =
                        unread === undefined
                            ? sql.empty()
                            : unread
                              ? sql`AND read_at IS NULL`
                              : sql`AND read_at IS NOT NULL`;
                    const boundary = cursor
                        ? sql`AND (created_at,id)<(SELECT created_at,id FROM inbox_items WHERE user_id=${userId}::uuid AND id=${cursor.id}::uuid)`
                        : sql.empty();
                    const ids = await queryRows<{ id: string }>(
                        tx,
                        sql`SELECT id FROM inbox_items WHERE user_id=${userId}::uuid ${read} ${boundary} ORDER BY created_at DESC,id DESC LIMIT ${take}`,
                    );
                    return tx.query.inboxItems.findMany({
                        where: and(
                            eq(inboxItems.userId, userId),
                            unread === undefined
                                ? undefined
                                : unread
                                  ? isNull(inboxItems.readAt)
                                  : isNotNull(inboxItems.readAt),
                            inArray(
                                inboxItems.id,
                                ids.map((row) => row.id),
                            ),
                        ),
                        with: inboxWith,
                        orderBy: [desc(inboxItems.createdAt), desc(inboxItems.id)],
                    });
                },
                { isolationLevel: 'repeatable read' },
            );
        },
        setInboxRead(userId: string, id: string, read: boolean, now: Date) {
            return services.db().transaction(async (tx) => {
                await tx
                    .update(inboxItems)
                    .set({ readAt: read ? now : null })
                    .where(
                        and(
                            eq(inboxItems.userId, userId),
                            eq(inboxItems.id, id),
                            read ? isNull(inboxItems.readAt) : undefined,
                        ),
                    );
                return readInbox(tx, and(eq(inboxItems.id, id), eq(inboxItems.userId, userId))!);
            });
        },
    };
}
