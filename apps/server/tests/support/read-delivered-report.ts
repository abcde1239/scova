import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@scova/models';
import { parseContract, ReportSchema } from '@scova/contracts';
import { createApiApp } from '../../src/app/index.ts';
import { createDefaultServices } from '../../src/app/context.ts';
import { csrfForSession, tokenHash } from '../../src/utils/security.ts';

// Test process boundary: the API resolves its own app aliases and reads the real Worker delivery.
const databaseUrl = process.env.SCOVA_REPORT_PROBE_DATABASE_URL;
const userId = process.env.SCOVA_REPORT_PROBE_USER_ID;
const reportId = process.env.SCOVA_REPORT_PROBE_REPORT_ID;
if (!databaseUrl || !userId || !reportId) throw new Error('报告读取探针缺少测试参数');
const database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const token = randomBytes(32).toString('base64url');
let sessionId: string | undefined;
try {
    const session = await database.session.create({
        data: {
            userId,
            tokenHash: tokenHash(token),
            csrfTokenHash: tokenHash(csrfForSession(token)),
            expiresAt: new Date(Date.now() + 60_000),
        },
    });
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
    process.stdout.write(JSON.stringify(report));
} finally {
    if (sessionId) await database.session.delete({ where: { id: sessionId } });
    await database.$disconnect();
}
