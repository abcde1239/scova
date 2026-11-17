import {
    eq,
    sql,
    queryRows,
    toolCalls as dbToolCalls,
    reports as dbReports,
    count as dbCount,
} from '@scova/db';
import { createConnectorBundle } from '@scova/connectors';
import { expect, it } from 'vite-plus/test';
import { type AgentRepository } from '../../src/repo/agent.ts';
import { setup, fixture, sessionFixture } from './fixture.ts';

export function registerDrain() {
    it('C14-ST05 stop 后 drain 等待已开始的真实 PG 调用，且不再进入 provider 或创建补偿写', async () => {
        const seed = await setup();
        const deferred = () => {
            let resolve!: () => void;
            const promise = new Promise<void>((done) => {
                resolve = done;
            });
            return { promise, resolve };
        };
        const locked = deferred();
        const release = deferred();
        const entered = deferred();
        const readerClosing = deferred();
        const releaseReader = deferred();
        let readerClosed = false;
        const locker = fixture.db.transaction(async (tx) => {
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${seed.run.id}))`,
            );
            locked.resolve();
            await release.promise;
        });
        const controller = new AbortController();
        let providerCalls = 0;
        const base = createConnectorBundle();
        const slowRepository: AgentRepository = {
            ...seed.repo,
            async reserve(input) {
                const held = await seed.repo.reserve(input);
                entered.resolve();
                await fixture.db.transaction(async (tx) => {
                    await queryRows<Record<string, unknown>>(
                        tx,
                        sql`SELECT 1 AS waited FROM pg_advisory_xact_lock(hashtext(${seed.run.id}))`,
                    );
                });
                return held;
            },
        };
        const { session, close } = sessionFixture(
            seed,
            {
                ...base,
                reader: {
                    ...base.reader,
                    async close() {
                        readerClosing.resolve();
                        await releaseReader.promise;
                        readerClosed = true;
                    },
                },
                search: {
                    async search(query, context) {
                        providerCalls++;
                        return base.search.search(query, context);
                    },
                },
            },
            { repository: slowRepository, signal: controller.signal },
        );
        let operation: Promise<unknown> | undefined;
        let draining: Promise<void> | undefined;
        try {
            await locked.promise;
            operation = session.tools.search('pending-database', 'query');
            void operation.catch(() => undefined);
            await entered.promise;
            controller.abort('stop');
            let drained = false;
            draining = session.drain().then(() => {
                drained = true;
            });
            await readerClosing.promise;
            expect(readerClosed).toBe(false);
            releaseReader.resolve();
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(readerClosed).toBe(true);
            expect(drained).toBe(false);
            release.resolve();
            await locker;
            await draining;
            await expect(operation).rejects.toMatchObject({ code: 'aborted' });
            expect(providerCalls).toBe(0);
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
            });
            expect(calls).toMatchObject([{ status: 'running', attemptNo: 1, outputRef: null }]);
            expect(await seed.repo.usage()).toMatchObject({ searches: 1 });
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbReports)
                    .where(eq(dbReports.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        } finally {
            releaseReader.resolve();
            release.resolve();
            await locker;
            await draining;
            await operation?.catch(() => undefined);
            await close();
        }
    });
}
