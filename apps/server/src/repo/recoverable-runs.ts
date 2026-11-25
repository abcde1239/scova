import { databaseClock, queryRows, sql, type DatabaseClient } from '@scova/db';

export interface RecoverableRun {
    id: string;
    leaseEpoch: number;
}

export async function listRecoverableRuns(
    db: DatabaseClient,
    limit: number,
): Promise<RecoverableRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('Run 恢复扫描上限必须为 1 至 1000 的整数');
    const rows = await queryRows<{ id: string; lease_epoch: number }>(
        db,
        sql`
SELECT id, lease_epoch FROM runs
WHERE status IN ('queued', 'running', 'recovering', 'cancel_requested')
  AND (lease_expires_at IS NULL OR lease_expires_at <= ${databaseClock(db)})
ORDER BY queued_at, id LIMIT ${limit}
      `,
    );
    return rows.map((row) => ({ id: row.id, leaseEpoch: row.lease_epoch }));
}
