import {
    and,
    asc,
    count,
    desc,
    eq,
    lt,
    notExists,
    reportAttachmentObjects,
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
    byteLength: sql<number>`coalesce(${reportResources.objectSize}, octet_length(${reportResources.content}))`,
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

    async function lockReport<T>(
        tx: DatabaseTransaction,
        input: NewResource,
        save: () => Promise<T>,
    ) {
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
        return report?.publishedAt.getTime() === input.reportVersion.getTime() ? save() : undefined;
    }

    function withReport<T>(input: NewResource, save: (tx: DatabaseTransaction) => Promise<T>) {
        return database().transaction((tx) => lockReport(tx, input, () => save(tx)));
    }

    async function findAttachment(tx: DatabaseTransaction, input: NewResource) {
        const [existing] = await tx
            .select(attachmentFields)
            .from(reportResources)
            .where(contentScope(input));
        return existing;
    }

    async function overQuota(tx: DatabaseTransaction, input: NewResource) {
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
        return (
            accountUsage!.total >= maxAttachmentsPerAccount ||
            reportUsage!.total >= maxAttachmentsPerReport
        );
    }

    /** Runs under the account lock. Re-checks dedupe and quota, then links the resource. */
    async function admitAttachment(tx: DatabaseTransaction, input: NewResource) {
        const existing = await findAttachment(tx, input);
        if (existing) return { kind: 'saved', row: existing } as const;
        if (await overQuota(tx, input)) return { kind: 'quota' } as const;
        const [row] = await tx.insert(reportResources).values(input).returning(attachmentFields);
        return { kind: 'saved', row: row! } as const;
    }

    function reservationScope(userId: string, id: string) {
        return and(eq(reportAttachmentObjects.userId, userId), eq(reportAttachmentObjects.id, id));
    }

    function objectScope(userId: string, id: string) {
        return and(eq(reportResources.userId, userId), eq(reportResources.objectId, id));
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
        async reserveAttachmentObject(userId: string, id: string, createdAt: Date) {
            await database().insert(reportAttachmentObjects).values({ userId, id, createdAt });
        },
        saveAttachment(input: NewResource, upload?: () => Promise<void>) {
            const { objectId } = input;
            if (!objectId || !upload) return withReport(input, (tx) => admitAttachment(tx, input));
            return database().transaction(async (tx) => {
                // Serialize identical uploads only. The account lock is not held during the PUT.
                const key = `report-attachment:${input.userId}:${input.reportId}:${input.contentKey}`;
                await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
                const existing = await findAttachment(tx, input);
                if (existing) return { kind: 'saved', row: existing } as const;
                // Early rejection avoids a wasted upload. Admission re-checks under the account lock.
                if (await overQuota(tx, input)) return { kind: 'quota' } as const;
                // Serialize upload with abandoned-object cleanup. The reservation itself
                // was committed before the network request and survives transaction failure.
                const [reserved] = await tx
                    .select({ id: reportAttachmentObjects.id })
                    .from(reportAttachmentObjects)
                    .where(reservationScope(input.userId, objectId))
                    .for('update');
                if (!reserved) throw new Error('附件对象预留已失效');
                await upload();
                return lockReport(tx, input, () => admitAttachment(tx, input));
            });
        },
        listAttachments(userId: string, reportId: string) {
            return database()
                .select(attachmentFields)
                .from(reportResources)
                .where(attachmentScope(userId, reportId))
                .orderBy(desc(reportResources.createdAt), desc(reportResources.id));
        },
        findUnusedAttachmentObjects(cutoff: Date, limit: number) {
            const db = database();
            return db
                .select({ userId: reportAttachmentObjects.userId, id: reportAttachmentObjects.id })
                .from(reportAttachmentObjects)
                .where(
                    and(
                        lt(reportAttachmentObjects.createdAt, cutoff),
                        notExists(
                            db
                                .select({ id: reportResources.id })
                                .from(reportResources)
                                .where(
                                    and(
                                        eq(reportResources.userId, reportAttachmentObjects.userId),
                                        eq(reportResources.objectId, reportAttachmentObjects.id),
                                    ),
                                ),
                        ),
                    ),
                )
                .orderBy(asc(reportAttachmentObjects.createdAt), asc(reportAttachmentObjects.id))
                .limit(limit);
        },
        async removeUnusedAttachmentObject(
            userId: string,
            id: string,
            remove: () => Promise<void>,
        ) {
            await database().transaction(async (tx) => {
                const [reserved] = await tx
                    .select({ id: reportAttachmentObjects.id })
                    .from(reportAttachmentObjects)
                    .where(reservationScope(userId, id))
                    .for('update', { skipLocked: true });
                if (!reserved) return;
                // Take a fresh snapshot after the row lock, which may have just been released
                // by an upload that committed a reference.
                const [reference] = await tx
                    .select({ id: reportResources.id })
                    .from(reportResources)
                    .where(objectScope(userId, id));
                if (reference) return;
                await remove();
                await tx.delete(reportAttachmentObjects).where(reservationScope(userId, id));
            });
        },
        async postponeAttachmentObjectCleanup(userId: string, id: string, now: Date) {
            // created_at is the cleanup eligibility clock. Moving it also sends the row to the back.
            await database()
                .update(reportAttachmentObjects)
                .set({ createdAt: now })
                .where(reservationScope(userId, id));
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
