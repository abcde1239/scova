import {
    type DatabaseClient,
    type Run,
    reports as dbReports,
    eq,
    and,
    type DatabaseTransaction,
} from '@scova/db';
import { withRunFence } from '../runs.ts';
import { RunFenceError, type RunLeaseToken } from '@scova/execution/runs';

/** All business writes share the Run fence; no provider/checkpointer I/O in this transaction. */
export function createDeliveryRepository(db: DatabaseClient) {
    async function existing(token: RunLeaseToken) {
        const report = await db.query.reports.findFirst({
            where: and(eq(dbReports.userId, token.userId), eq(dbReports.runId, token.runId)),
        });
        return report ? { reportId: report.id, reused: true } : null;
    }
    return {
        async inRunFence(
            token: RunLeaseToken,
            deadline: boolean,
            work: (
                tx: DatabaseTransaction,
                run: Run,
                now: Date,
            ) => Promise<{ reportId: string; reused: boolean }>,
        ): Promise<{ reportId: string; reused: boolean }> {
            const already = await existing(token);
            if (already) return already;
            try {
                return await withRunFence(
                    db,
                    token,
                    deadline ? 'deadline_delivery' : 'delivery',
                    work,
                );
            } catch (error) {
                if (error instanceof RunFenceError) {
                    const committed = await existing(token);
                    if (committed) return committed;
                }
                throw error;
            }
        },
    };
}
