import { and, count, eq, lte, reportExports, users, type DatabaseClient } from '@scova/db';

const maxExportsPerAccount = 32;
type ExportRow = typeof reportExports.$inferSelect;
type NewExport = typeof reportExports.$inferInsert & { format: ExportRow['format'] };

export function createReportExportRepo(database: () => DatabaseClient) {
    return {
        save(input: NewExport) {
            return database().transaction(async (tx) => {
                // Serialize quota admission and retries per owner, not across accounts.
                const [owner] = await tx
                    .select({ id: users.id })
                    .from(users)
                    .where(eq(users.id, input.userId))
                    .for('update');
                if (!owner) return { kind: 'missing' } as const;

                const account = eq(reportExports.userId, input.userId);
                await tx
                    .delete(reportExports)
                    .where(and(account, lte(reportExports.expiresAt, input.createdAt)));
                const [existing] = await tx
                    .select()
                    .from(reportExports)
                    .where(
                        and(
                            account,
                            eq(reportExports.reportId, input.reportId),
                            eq(reportExports.format, input.format),
                            eq(reportExports.rendererVersion, input.rendererVersion),
                        ),
                    );
                // Retire outdated content, never serve it after the authorized DTO changes.
                if (existing?.sha256 === input.sha256)
                    return { kind: 'saved', row: existing } as const;
                if (existing)
                    await tx
                        .delete(reportExports)
                        .where(and(account, eq(reportExports.id, existing.id)));
                const [usage] = await tx
                    .select({ total: count() })
                    .from(reportExports)
                    .where(account);
                if (usage!.total >= maxExportsPerAccount) return { kind: 'quota' } as const;
                const [row] = await tx.insert(reportExports).values(input).returning();
                return { kind: 'saved', row: row! } as const;
            });
        },
    };
}
