import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { nextScheduledAt, resolveScheduledDate } from '@scova/shared';
import { createDatabaseClient, closeDatabase, sql, eq } from '@scova/db';
import { pgTable, text, integer } from 'drizzle-orm/pg-core';

const databaseUrl =
    process.env.RUNTIME_DATABASE_URL ??
    'postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test';
const redisUrl = process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';

function runProcess(script, args, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
            env: { ...process.env, RUNTIME_DATABASE_URL: databaseUrl, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`Runtime 子进程退出 ${code}: ${stderr || stdout}`));
        });
    });
}

export function testDst() {
    const zone = 'America/New_York';
    const gapPlan = { timezone: zone, schedule: { frequency: 'daily', localTime: '02:30' } };
    const foldPlan = { timezone: zone, schedule: { frequency: 'daily', localTime: '01:30' } };
    const gap = resolveScheduledDate(gapPlan, '2026-03-08');
    const fold = resolveScheduledDate(foldPlan, '2026-11-01');
    assert.equal(gap.toISOString(), '2026-03-08T07:00:00.000Z', '缺失时刻取首个有效时刻03:00');
    assert.equal(fold.toISOString(), '2026-11-01T05:30:00.000Z', '重复时刻取较早一次');
    assert.equal(
        nextScheduledAt(gapPlan, gap).toISOString(),
        '2026-03-09T06:30:00.000Z',
        '次日恢复配置时分',
    );
    assert.equal(nextScheduledAt(foldPlan, fold).toISOString(), '2026-11-02T06:30:00.000Z');
    assert.equal(
        nextScheduledAt(foldPlan, new Date('2026-11-01T06:00:00Z')).toISOString(),
        '2026-11-02T06:30:00.000Z',
        '回拨两次之间不再次执行当天时点',
    );
    console.log(
        JSON.stringify({
            test: 'dst',
            gapUtc: gap.toISOString(),
            foldUtc: fold.toISOString(),
            passed: true,
        }),
    );
}

async function testDrizzle(schema) {
    const probe = pgTable('drizzle_probe', {
        id: text('id').primaryKey(),
        value: integer('value').notNull(),
    });
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('schema', schema);
    const db = createDatabaseClient({ connectionString: scopedUrl.toString(), max: 2 });
    try {
        await db.execute(
            sql`CREATE TABLE drizzle_probe (id text PRIMARY KEY, value integer NOT NULL)`,
        );
        await db.transaction(async (tx) => {
            await tx.insert(probe).values({ id: 'committed', value: 1 });
            await tx.update(probe).set({ value: 2 }).where(eq(probe.id, 'committed'));
        });
        await assert.rejects(
            db.transaction(async (tx) => {
                await tx.insert(probe).values({ id: 'rolled-back', value: 9 });
                throw new Error('expected rollback');
            }),
            /expected rollback/,
        );
        const rows = await db.select().from(probe);
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0], { id: 'committed', value: 2 });
    } finally {
        await closeDatabase(db);
    }
    console.log(
        JSON.stringify({
            test: 'drizzle-transaction',
            committed: 1,
            rolledBack: true,
            passed: true,
        }),
    );
}

async function testQueue(suffix) {
    const name = `runtime-${suffix}`;
    const connections = Array.from(
        { length: 3 },
        () =>
            new Redis(redisUrl, {
                maxRetriesPerRequest: null,
                retryStrategy: () => null,
                connectTimeout: 5000,
                lazyConnect: true,
            }),
    );
    const [queueConnection, eventConnection, workerConnection] = connections;
    for (const connection of connections) connection.on('error', () => {});
    let queue;
    let events;
    let worker;
    let executionError;
    const cleanupErrors = [];
    try {
        await Promise.all(connections.map((connection) => connection.connect()));
        queue = new Queue(name, { connection: queueConnection });
        events = new QueueEvents(name, { connection: eventConnection });
        await events.waitUntilReady();
        let calls = 0;
        worker = new Worker(
            name,
            async (job) => {
                calls += 1;
                assert.equal(job.data.runId, suffix);
                return { value: 'received' };
            },
            { connection: workerConnection, concurrency: 1 },
        );
        worker.on('error', () => {});
        await worker.waitUntilReady();
        const jobId = `run-${suffix}`;
        const job = await queue.add(
            'execute',
            { runId: suffix },
            { jobId, removeOnComplete: false },
        );
        assert.deepEqual(await job.waitUntilFinished(events, 10000), { value: 'received' });
        const repeated = await queue.add(
            'execute',
            { runId: suffix },
            { jobId, removeOnComplete: false },
        );
        assert.equal(repeated.id, job.id);
        assert.equal(await queue.getJobCountByTypes('completed'), 1);
        assert.equal(calls, 1);
    } catch (error) {
        executionError = error;
    } finally {
        // 只删除本次唯一命名的队列，禁止使用 FLUSHALL 清理共享 Redis。
        const cleanup = async (operation) => {
            try {
                await operation();
            } catch (error) {
                cleanupErrors.push(error);
            }
        };
        if (worker) await cleanup(() => worker.close());
        if (events) await cleanup(() => events.close());
        if (queue) {
            await cleanup(() => queue.obliterate({ force: true }));
            await cleanup(() => queue.close());
        }
        await Promise.all(
            connections.map(async (connection) => {
                if (connection.status !== 'end')
                    await connection.quit().catch(() => connection.disconnect());
            }),
        );
    }
    if (executionError) throw executionError;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '测试队列清理失败');
    console.log(
        JSON.stringify({
            test: 'bullmq',
            deliveredJobs: 1,
            duplicateSuppressed: true,
            passed: true,
        }),
    );
}

async function testCheckpoint(pool, schema) {
    const runId = randomUUID();
    await pool.query(`CREATE TABLE "${schema}".runs (
    id uuid PRIMARY KEY, lease_epoch integer NOT NULL, lease_owner text NOT NULL,
    lease_expires_at timestamptz NOT NULL, checkpoint_ref jsonb
  )`);
    await pool.query(`CREATE TABLE "${schema}".node_calls (
    run_id uuid NOT NULL, node text NOT NULL, PRIMARY KEY (run_id, node)
  )`);
    await pool.query(
        `CREATE TABLE "${schema}".deliveries (run_id uuid PRIMARY KEY, value text NOT NULL)`,
    );
    await pool.query(
        `INSERT INTO "${schema}".runs (id, lease_epoch, lease_owner, lease_expires_at)
    VALUES ($1, 1, 'worker-1', now() + interval '2 minutes')`,
        [runId],
    );
    const script = fileURLToPath(new URL('checkpoint-child.mjs', import.meta.url));
    // 故意异常的独立进程也必须关闭 saver 连接池并退出，不能靠强制退出通过。
    await assert.rejects(
        runProcess(script, ['failure', schema, runId]),
        /expected-runtime-failure/,
    );
    const outputs = [];
    for (const phase of ['prepare', 'takeover', 'resume']) {
        const output = await runProcess(script, [phase, schema, runId]);
        console.log(output.trim());
        outputs.push(JSON.parse(output.trim().split('\n').at(-1)));
    }
    assert.equal(new Set(outputs.map((output) => output.pid)).size, 3, '必须是三个独立进程');
    assert.equal(
        (await pool.query(`SELECT count(*)::int AS count FROM "${schema}".node_calls`)).rows[0]
            .count,
        2,
    );
    assert.equal(
        (await pool.query(`SELECT count(*)::int AS count FROM "${schema}".deliveries`)).rows[0]
            .count,
        1,
    );
    console.log(
        JSON.stringify({
            test: 'durable-checkpoint',
            independentProcesses: 3,
            nodeCalls: 2,
            deliveries: 1,
            stalePromotionRejected: true,
            exceptionalProcessExited: true,
            passed: true,
        }),
    );
}

export async function runRuntimeTests({ onlyDst = false } = {}) {
    console.log(
        JSON.stringify({
            runtime: typeof Bun === 'undefined' ? 'node' : 'bun',
            version: process.versions.bun ?? process.version,
        }),
    );
    testDst();
    if (onlyDst) return;
    const suffix = randomBytes(12).toString('hex');
    const schema = `runtime_${suffix}`;
    const pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 2,
        connectionTimeoutMillis: 5000,
    });
    let created = false;
    try {
        // 名称全部由本进程生成并验证，不能通过环境注入要删除的 schema。
        assert.match(schema, /^runtime_[a-f0-9]{24}$/);
        await pool.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await testDrizzle(schema);
        await testQueue(suffix);
        await testCheckpoint(pool, schema);
    } finally {
        try {
            if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
            await pool.end();
        }
    }
    console.log(
        'Runtime 实验通过：Drizzle 事务、BullMQ、PostgreSQL checkpoint 跨进程恢复与 fencing、DST。',
    );
}
