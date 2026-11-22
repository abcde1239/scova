import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    taskVersions as dbTaskVersions,
    runs as dbRuns,
} from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { ConnectorError, createConnectorBundle, type ConnectorBundle } from '@scova/connectors';
import { createLocalAgentRuntime as createAgentRuntime } from '../support/local-agent-runtime.ts';
import { RunService } from '../../src/service/runs.ts';
import { seedRun } from '../support/run-database.ts';
import { research, fixture, runs, delivery, assertEmpty, schema } from './fixture.ts';

export function registerDeliveryFailures() {
    it('旧epoch交付拒绝；成功账本与候选无正文时NO_EVIDENCE失败不产生报告', async () => {
        const seed = await research();
        await fixture.db
            .update(dbRuns)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const next = await runs.claim(seed.run.id, 'new-owner');
        expect(next.kind).toBe('claimed');
        await expect(delivery.deliver(seed.claimed.token, seed.candidate)).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await assertEmpty(seed.run.id);
        const empty = await seedRun(fixture.db);
        const base = createConnectorBundle();
        const bundle: ConnectorBundle = {
            ...base,
            reader: {
                async read() {
                    throw new ConnectorError('extraction_failed', 'no body');
                },
            },
        };
        const runtime = createAgentRuntime({
            database: fixture.db,
            databaseUrl: fixture.databaseUrl,
            checkpointSchema: schema,
            bundle,
            enableDelivery: true,
        });
        try {
            await runtime.connect();
            expect(
                await new RunService({
                    repository: runs,
                    executorFactory: (token) => runtime.executorFactory(token),
                }).execute(empty.run.id),
            ).toBe('processed');
            expect(
                await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, empty.run.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({ status: 'failed', failureCode: 'NO_EVIDENCE' });
            await assertEmpty(empty.run.id);
        } finally {
            await runtime.close();
        }
    });

    it.each(['demo', 'live'] as const)(
        '生产runtime对%s缺配置明确失败，不交付演示报告',
        async (mode) => {
            const seed = await seedRun(fixture.db, { mode });
            const runtime = createAgentRuntime({
                database: fixture.db,
                databaseUrl: fixture.databaseUrl,
                checkpointSchema: schema,
                enableDelivery: true,
                env: {},
            });
            try {
                await runtime.connect();
                await new RunService({
                    repository: runs,
                    executorFactory: (token) => runtime.executorFactory(token),
                }).execute(seed.run.id);
                const run = await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                    .then((row) => requiredDatabaseValue(row));
                expect(run).toMatchObject({
                    status: 'failed',
                    outcome: null,
                    failureCode: 'AGENT_CONFIGURATION_INVALID',
                });
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbReports)
                        .where(eq(dbReports.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
            } finally {
                await runtime.close();
            }
        },
    );

    it('显式API未配置时持久化具体原因，不发送外部调用', async () => {
        const seed = await seedRun(fixture.db, { mode: 'live' });
        await fixture.db
            .update(dbTaskVersions)
            .set({ configJson: { ...seed.config, searchMode: 'api' } })
            .where(eq(dbTaskVersions.id, seed.version.id));
        const runtime = createAgentRuntime({
            database: fixture.db,
            databaseUrl: fixture.databaseUrl,
            checkpointSchema: schema,
            enableDelivery: true,
            env: {},
        });
        try {
            await runtime.connect();
            await new RunService({
                repository: runs,
                executorFactory: (token) => runtime.executorFactory(token),
            }).execute(seed.run.id);
            const result = await fixture.db.query.runs.findFirst({
                where: eq(dbRuns.id, seed.run.id),
            });
            expect(result).toMatchObject({
                status: 'failed',
                failureCode: 'SEARCH_API_NOT_CONFIGURED',
            });
            await assertEmpty(seed.run.id);
        } finally {
            await runtime.close();
        }
    });
}
