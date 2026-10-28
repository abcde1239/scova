import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    type Run,
    taskVersions as dbTaskVersions,
    eq,
    and,
    notifications as dbNotifications,
    type DatabaseTransaction,
} from '@scova/db';

import { terminalNotificationKind } from '@/utils/notifications.ts';

/** Only the fixed version is read. Broken preferences suppress notifications without blocking failure persistence. */
export async function createTerminalNotifications(
    tx: DatabaseTransaction,
    run: Run,
    terminal: { status: 'succeeded' | 'partial' | 'failed'; outcome?: string; reportId?: string },
) {
    const version = await tx.query.taskVersions.findFirst({
        where: and(
            eq(dbTaskVersions.id, run.taskVersionId),
            eq(dbTaskVersions.userId, run.userId),
            eq(dbTaskVersions.taskId, run.taskId),
        ),
        columns: { configJson: true },
    });
    const config = version?.configJson;
    const preference =
        config && typeof config === 'object' && !Array.isArray(config)
            ? config.notificationPreference
            : undefined;
    const kind = terminalNotificationKind(preference, terminal);
    if (!kind) return;
    await tx
        .insert(dbNotifications)
        .values({
            userId: run.userId,
            runId: run.id,
            kind: kind,
            reportId: terminal.reportId ?? null,
        })
        .onConflictDoNothing({
            target: [dbNotifications.userId, dbNotifications.runId, dbNotifications.kind],
        })
        .returning()
        .then(
            async (rows) =>
                rows[0] ??
                requiredDatabaseValue(
                    await tx.query.notifications.findFirst({
                        where: and(
                            eq(dbNotifications.userId, run.userId),
                            eq(dbNotifications.runId, run.id),
                            eq(dbNotifications.kind, kind),
                        ),
                    }),
                ),
        );
}
