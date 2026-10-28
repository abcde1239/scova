import { createDatabaseClient, closeDatabase, and, eq } from '@scova/db';
import * as tables from '@scova/db';
import { randomBytes } from 'node:crypto';
import { parseContract, ReportSchema, NotificationListResponseSchema } from '@scova/models';
import { createApiApp } from '../../src/app/index.ts';
import { createDefaultServices } from '../../src/app/services.ts';
import { csrfForSession, tokenHash } from '../../src/utils/security.ts';
import { firstRow } from '../../src/utils/database.ts';

// Test process boundary: the API resolves its own app aliases and reads the real Worker delivery.
const databaseUrl = process.env.SCOVA_REPORT_PROBE_DATABASE_URL;
const userId = process.env.SCOVA_REPORT_PROBE_USER_ID;
const reportId = process.env.SCOVA_REPORT_PROBE_REPORT_ID;
if (!databaseUrl || !userId || !reportId) throw new Error('报告读取探针缺少测试参数');
const database = createDatabaseClient({ connectionString: databaseUrl });
const token = randomBytes(32).toString('base64url');
let sessionId: string | undefined;
try {
    const session = await database
        .insert(tables.sessions)
        .values({
            userId: userId,
            tokenHash: tokenHash(token),
            csrfTokenHash: tokenHash(csrfForSession(token)),
            expiresAt: new Date(Date.now() + 60_000),
        })
        .returning()
        .then(firstRow);
    sessionId = session.id;
    const origin = 'https://scova.test';
    const app = createApiApp(
        'node',
        createDefaultServices({ origin, db: () => database, production: false }),
    );
    const response = await app.handle(
        new Request(`${origin}/api/v1/reports/${reportId}`, {
            headers: { cookie: `scova_session=${token}` },
        }),
    );
    if (response.status !== 200)
        throw new Error(`已交付报告 API 返回 ${response.status}: ${await response.text()}`);
    const report = parseContract(ReportSchema, await response.json());
    const expectedKind = process.env.SCOVA_REPORT_PROBE_NOTIFICATION_KIND;
    if (expectedKind) {
        const notifications = await app.handle(
            new Request(`${origin}/api/v1/notifications`, {
                headers: { cookie: `scova_session=${token}` },
            }),
        );
        if (notifications.status !== 200) throw new Error('已交付通知API读取失败');
        const page = parseContract(NotificationListResponseSchema, await notifications.json());
        const matching = page.items.filter((item) => item.runId === report.runId);
        if (
            matching.length !== 1 ||
            matching[0]?.kind !== expectedKind ||
            matching[0].reportId !== report.id
        )
            throw new Error('已交付通知与报告关联或种类不一致');
    }
    process.stdout.write(JSON.stringify(report));
} finally {
    if (sessionId)
        await database
            .delete(tables.sessions)
            .where(and(eq(tables.sessions.id, sessionId)))
            .returning()
            .then(firstRow);
    await closeDatabase(database);
}
