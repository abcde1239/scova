import {
    and,
    count,
    desc,
    eq,
    reportResources,
    reports,
    sql,
    users,
    type DatabaseClient,
    type DatabaseTransaction,
} from '@scova/db';

type NewResource = typeof reportResources.$inferInsert;
const maxAttachmentsPerReport = 16;
const maxAttachmentsPerAccount = 64;
const attachmentPurpose = 'reference-csv';
const attachmentFields = {
    id: reportResources.id,
    reportId: reportResources.reportId,
    metadata: reportResources.metadata,
    byteLength: sql<number>`octet_length(${reportResources.content})`,
    createdAt: reportResources.createdAt,
};

export function createReportResourceRepo(database: () => DatabaseClient) {
    function scope(userId: string, reportId: string) {
        return and(eq(reportResources.userId, userId), eq(reportResources.reportId, reportId));
    }

    function reportScope(userId: string, reportId: string) {
        return and(eq(reports.userId, userId), eq(reports.id, reportId));
    }

    function contentScope(input: NewResource) {
        return and(
            scope(input.userId, input.reportId),
            eq(reportResources.purpose, input.purpose),
            eq(reportResources.reportVersion, input.reportVersion),
            eq(reportResources.version, input.version),
            eq(reportResources.contentKey, input.contentKey),
        );
    }

    function withReport<T>(input: NewResource, save: (tx: DatabaseTransaction) => Promise<T>) {
        return database().transaction(async (tx) => {
            // Match the account-before-resource lock order used by the existing export service.
            const [owner] = await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, input.userId))
                .for('update');
            if (!owner) return undefined;
            const [report] = await tx
                .select({ publishedAt: reports.publishedAt })
                .from(reports)
                .where(reportScope(input.userId, input.reportId))
                .for('key share');
            return report?.publishedAt.getTime() === input.reportVersion.getTime()
                ? save(tx)
                : undefined;
        });
    }

    function attachmentScope(userId: string, reportId: string) {
        return and(scope(userId, reportId), eq(reportResources.purpose, attachmentPurpose));
    }

    return {
        async publishedAt(userId: string, reportId: string) {
            const [row] = await database()
                .select({ publishedAt: reports.publishedAt })
                .from(reports)
                .where(reportScope(userId, reportId));
            return row?.publishedAt;
        },
        async find(userId: string, reportId: string, id: string, purpose: NewResource['purpose']) {
            const [row] = await database()
                .select()
                .from(reportResources)
                .where(
                    and(
                        scope(userId, reportId),
                        eq(reportResources.id, id),
                        eq(reportResources.purpose, purpose),
                    ),
                );
            return row;
        },
        saveChart(input: NewResource, now: Date) {
            return withReport(input, async (tx) => {
                const [existing] = await tx
                    .select()
                    .from(reportResources)
                    .where(contentScope(input));
                if (existing?.expiresAt && existing.expiresAt > now) return existing;
                if (existing) {
                    const [renewed] = await tx
                        .update(reportResources)
                        .set({ expiresAt: input.expiresAt })
                        .where(eq(reportResources.id, existing.id))
                        .returning();
                    return renewed;
                }
                const [inserted] = await tx.insert(reportResources).values(input).returning();
                return inserted;
            });
        },
        saveAttachment(input: NewResource) {
            return withReport(input, async (tx) => {
                const [existing] = await tx
                    .select(attachmentFields)
                    .from(reportResources)
                    .where(contentScope(input));
                if (existing) return { kind: 'saved', row: existing } as const;
                const [accountUsage] = await tx
                    .select({ total: count() })
                    .from(reportResources)
                    .where(
                        and(
                            eq(reportResources.userId, input.userId),
                            eq(reportResources.purpose, attachmentPurpose),
                        ),
                    );
                const [reportUsage] = await tx
                    .select({ total: count() })
                    .from(reportResources)
                    .where(attachmentScope(input.userId, input.reportId));
                if (
                    accountUsage!.total >= maxAttachmentsPerAccount ||
                    reportUsage!.total >= maxAttachmentsPerReport
                )
                    return { kind: 'quota' } as const;
                const [row] = await tx
                    .insert(reportResources)
                    .values(input)
                    .returning(attachmentFields);
                return { kind: 'saved', row: row! } as const;
            });
        },
        listAttachments(userId: string, reportId: string) {
            return database()
                .select(attachmentFields)
                .from(reportResources)
                .where(attachmentScope(userId, reportId))
                .orderBy(desc(reportResources.createdAt), desc(reportResources.id));
        },
        async removeAttachment(userId: string, reportId: string, id: string) {
            const [removed] = await database()
                .delete(reportResources)
                .where(and(attachmentScope(userId, reportId), eq(reportResources.id, id)))
                .returning({ id: reportResources.id });
            return removed;
        },
    };
}
