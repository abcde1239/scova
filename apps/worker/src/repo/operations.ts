import { readdir } from 'node:fs/promises';
import type pg from 'pg';
import type { OutboxMessage } from '@/utils/outbox.ts';
import { installedCheckpointVersion } from '@/utils/checkpoint-version.ts';
import type { OperationConfig } from '@/app/operations.ts';

/** Offline maintenance shares one transaction with business rows and all saver epochs. */
export function createOperationRepository(pool: pg.Pool, config: OperationConfig) {
    const business = `"${config.businessSchema}"`;
    const agent = `"${config.checkpointSchema}"`;
    async function transaction<T>(operation: (client: pg.PoolClient) => Promise<T>) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['scova-maintenance']);
            await client.query(`SET LOCAL search_path TO ${business}, pg_catalog`);
            const result = await operation(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    async function deleteThreads(client: pg.PoolClient, ids: string[]) {
        let count = 0;
        for (const table of ['checkpoint_writes', 'checkpoint_blobs', 'checkpoints']) {
            const result = await client.query(
                `DELETE FROM ${agent}.${table} c
        WHERE EXISTS (SELECT 1 FROM unnest($1::uuid[]) r(id)
          WHERE c.thread_id ~ ('^run-' || r.id::text || '-epoch-[0-9]+$'))`,
                [ids],
            );
            count += result.rowCount ?? 0;
        }
        return count;
    }
    return {
        async readiness() {
            const client = await pool.connect();
            try {
                const migrations =
                    await client.query(`SELECT migration_name FROM ${business}._prisma_migrations
          WHERE finished_at IS NULL AND rolled_back_at IS NULL`);
                if (migrations.rowCount) throw new Error('业务迁移尚未完成');
                const expected = (
                    await readdir(
                        new URL('../../../../packages/db/prisma/migrations/', import.meta.url),
                        { withFileTypes: true },
                    )
                )
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => entry.name);
                const applied = await client.query(
                    `SELECT migration_name FROM ${business}._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
                );
                if (
                    expected.some(
                        (name) => !applied.rows.some((row) => row.migration_name === name),
                    )
                )
                    throw new Error('业务迁移缺失');
                // The migration job records the exact installed saver package version.
                const ready = await client.query(
                    `SELECT version FROM ${agent}.scova_schema_version WHERE id = 1`,
                );
                if (ready.rows[0]?.version !== installedCheckpointVersion())
                    throw new Error('图状态迁移版本不匹配');
                await client.query(`SELECT 1 FROM ${agent}.checkpoints LIMIT 0`);
                await client.query(`SELECT 1 FROM ${agent}.checkpoint_blobs LIMIT 0`);
                await client.query(`SELECT 1 FROM ${agent}.checkpoint_writes LIMIT 0`);
            } finally {
                client.release();
            }
        },
        async assertEmptyDatabase() {
            const result = await pool.query(
                `SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') LIMIT 1`,
            );
            if (result.rowCount) throw new Error('恢复目标必须为空数据库；使用新卷或独立空库');
        },
        async retention(apply: boolean) {
            return transaction(async (client) => {
                const runs = await client.query<{ id: string }>(`SELECT id FROM runs
          WHERE status IN ('succeeded','partial','failed','canceled') AND finished_at < now() - interval '30 days'
          AND (checkpoint_ref IS NOT NULL OR EXISTS (SELECT 1 FROM tool_calls t WHERE t.run_id=runs.id AND t.output_ref IS NOT NULL)
            OR EXISTS (SELECT 1 FROM ${agent}.checkpoints c WHERE c.thread_id ~ ('^run-' || runs.id::text || '-epoch-[0-9]+$'))
            OR EXISTS (SELECT 1 FROM ${agent}.checkpoint_blobs c WHERE c.thread_id ~ ('^run-' || runs.id::text || '-epoch-[0-9]+$'))
            OR EXISTS (SELECT 1 FROM ${agent}.checkpoint_writes c WHERE c.thread_id ~ ('^run-' || runs.id::text || '-epoch-[0-9]+$')))
          ORDER BY finished_at, id LIMIT 100 FOR UPDATE`);
                const ids = runs.rows.map((run) => run.id);
                const bodies = await client.query(`SELECT id FROM source_snapshots s
          WHERE text_body IS NOT NULL AND text_expires_at <= now()
          AND NOT EXISTS (SELECT 1 FROM run_sources rs JOIN runs r ON r.id=rs.run_id
            WHERE rs.snapshot_id=s.id AND r.status IN ('queued','running','recovering','cancel_requested'))
          ORDER BY text_expires_at, id LIMIT 100 FOR UPDATE`);
                if (!apply)
                    return { runs: ids.length, bodies: bodies.rowCount ?? 0, applied: false };
                const bodyIds = bodies.rows.map((row: { id: string }) => row.id);
                await client.query(
                    'UPDATE source_snapshots SET text_body=NULL WHERE id=ANY($1::uuid[])',
                    [bodyIds],
                );
                await client.query(
                    'UPDATE tool_calls SET output_ref=NULL WHERE run_id=ANY($1::uuid[])',
                    [ids],
                );
                const checkpointRows = await deleteThreads(client, ids);
                await client.query('UPDATE runs SET checkpoint_ref=NULL WHERE id=ANY($1::uuid[])', [
                    ids,
                ]);
                return { runs: ids.length, bodies: bodyIds.length, checkpointRows, applied: true };
            });
        },
        async accountOutbox(userId: string) {
            return (
                await pool.query<OutboxMessage>(
                    `SELECT id, event_type AS "eventType", payload FROM ${business}.outbox WHERE user_id=$1::uuid`,
                    [userId],
                )
            ).rows;
        },
        async accountRuns(userId: string) {
            return (
                await pool.query<{ id: string; lease_epoch: number }>(
                    `SELECT id, lease_epoch FROM ${business}.runs WHERE user_id=$1::uuid`,
                    [userId],
                )
            ).rows;
        },
        async deleteAccount(userId: string, apply: boolean) {
            return transaction(async (client) => {
                const user = await client.query(
                    'SELECT id FROM users WHERE id=$1::uuid FOR UPDATE',
                    [userId],
                );
                if (!user.rowCount) return { found: false, applied: false };
                const runs = await client.query<{ id: string }>(
                    'SELECT id FROM runs WHERE user_id=$1::uuid FOR UPDATE',
                    [userId],
                );
                const ids = runs.rows.map((run) => run.id);
                if (!apply) return { found: true, runs: ids.length, applied: false };
                await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1::uuid', [
                    userId,
                ]);
                await client.query(
                    "UPDATE tasks SET status='archived', next_run_at=NULL WHERE user_id=$1::uuid",
                    [userId],
                );
                await deleteThreads(client, ids);
                // Every business row has a same-owner User CASCADE; NO ACTION links are checked after this statement.
                await client.query('DELETE FROM users WHERE id=$1::uuid', [userId]);
                return { found: true, runs: ids.length, applied: true, runIds: ids };
            });
        },
    };
}
