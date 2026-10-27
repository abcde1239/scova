import { Prisma } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';

const summaryInclude = { run: true } satisfies Prisma.ReportInclude;
const evidenceInclude = {
    observation: {
        include: {
            source: true,
            snapshot: {
                select: {
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
} satisfies Prisma.EvidenceInclude;
const detailInclude = {
    ...summaryInclude,
    baseline: true,
    claims: {
        orderBy: { order: 'asc' },
        include: { citations: { include: { evidence: { include: evidenceInclude } } } },
    },
    changes: {
        orderBy: { id: 'asc' },
        include: { citations: { include: { evidence: { include: evidenceInclude } } } },
    },
} satisfies Prisma.ReportInclude;
const inboxInclude = { report: { include: summaryInclude } } satisfies Prisma.InboxItemInclude;
type Cursor = { id: string; time: Date };

export type StoredReportSummary = Prisma.ReportGetPayload<{ include: typeof summaryInclude }>;
export type StoredReport = Prisma.ReportGetPayload<{ include: typeof detailInclude }>;
export type StoredEvidence = Prisma.EvidenceGetPayload<{ include: typeof evidenceInclude }>;
export type StoredInboxItem = Prisma.InboxItemGetPayload<{ include: typeof inboxInclude }>;

/** 所有查询与写入均绑定会话 owner；完整正文不进入报告读取查询。 */
export function createReportRepo(services: Pick<ApiServices, 'db'>) {
    return {
        findTask(userId: string, id: string) {
            return services.db().task.findFirst({ where: { id, userId }, select: { id: true } });
        },
        findReportAnchor(userId: string, id: string) {
            return services.db().report.findFirst({
                where: { id, userId },
                select: { id: true, taskId: true, publishedAt: true },
            });
        },
        listReports(userId: string, take: number, taskId?: string, cursor?: Cursor) {
            return services.db().report.findMany({
                where: {
                    userId,
                    ...(taskId ? { taskId } : {}),
                    ...(cursor
                        ? {
                              OR: [
                                  { publishedAt: { lt: cursor.time } },
                                  { publishedAt: cursor.time, id: { lt: cursor.id } },
                              ],
                          }
                        : {}),
                },
                include: summaryInclude,
                orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
                take,
            });
        },
        findReport(userId: string, id: string) {
            return services
                .db()
                .report.findFirst({ where: { id, userId }, include: detailInclude });
        },
        findInboxAnchor(userId: string, id: string) {
            return services.db().inboxItem.findFirst({
                where: { id, userId },
                select: { id: true, createdAt: true },
            });
        },
        listInbox(userId: string, take: number, unread?: boolean, cursor?: Cursor) {
            return services.db().inboxItem.findMany({
                where: {
                    userId,
                    ...(unread === undefined ? {} : { readAt: unread ? null : { not: null } }),
                    ...(cursor
                        ? {
                              OR: [
                                  { createdAt: { lt: cursor.time } },
                                  { createdAt: cursor.time, id: { lt: cursor.id } },
                              ],
                          }
                        : {}),
                },
                include: inboxInclude,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take,
            });
        },
        setInboxRead(userId: string, id: string, read: boolean, now: Date) {
            return services.db().$transaction(async (database) => {
                await database.inboxItem.updateMany({
                    where: { userId, id, ...(read ? { readAt: null } : {}) },
                    data: { readAt: read ? now : null },
                });
                return database.inboxItem.findFirst({
                    where: { id, userId },
                    include: inboxInclude,
                });
            });
        },
    };
}
