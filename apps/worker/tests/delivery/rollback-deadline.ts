import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    runs as dbRuns,
    sql,
    sources as dbSources,
    and,
    runEvents as dbRunEvents,
    queryRows,
    sourceSnapshots as dbSourceSnapshots,
} from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { research, fixture, delivery, assertEmpty, runs } from './fixture.ts';

export function registerRollbackDeadline() {
    it('取消事务先持有Run锁时，等待中的交付不得保存任何成果', async () => {
        const seed = await research();
        let unlock!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const release = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        const cancel = fixture.db.transaction(async (tx) => {
            await queryRows<Record<string, unknown>>(
                tx,
                sql`SELECT id FROM runs WHERE id=${seed.run.id}::uuid FOR UPDATE`,
            );
            await tx
                .update(dbRuns)
                .set({ status: 'cancel_requested', cancelRequestedAt: new Date() })
                .where(eq(dbRuns.id, seed.run.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            entered();
            await release;
        });
        try {
            await held;
            const delivering = delivery.deliver(seed.claimed.token, seed.candidate);
            void delivering.catch(() => undefined);
            unlock();
            await cancel;
            await expect(delivering).rejects.toMatchObject({ code: 'RUN_CANCELED' });
            await assertEmpty(seed.run.id);
            expect(await runs.finish(seed.claimed.token, { code: 'EXECUTOR_FAILED' })).toBe(true);
            expect(
                await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({
                status: 'canceled',
            });
        } finally {
            unlock();
            await cancel;
        }
    });

    it('事务末尾Inbox写入失败回滚来源、快照、证据、报告及Run状态', async () => {
        const seed = await research();
        await fixture.db.execute(
            sql.raw(
                `CREATE FUNCTION fail_delivery_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected inbox failure'; END $$`,
            ),
        );
        await fixture.db.execute(
            sql.raw(
                `CREATE TRIGGER fail_delivery_inbox BEFORE INSERT ON inbox_items FOR EACH ROW EXECUTE FUNCTION fail_delivery_inbox()`,
            ),
        );
        try {
            await expect(delivery.deliver(seed.claimed.token, seed.candidate)).rejects.toThrow();
            await assertEmpty(seed.run.id);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbSources)
                    .where(eq(dbSources.userId, seed.user.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbSourceSnapshots)
                    .where(eq(dbSourceSnapshots.userId, seed.user.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
            expect(
                await fixture.db.query.runs
                    .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                    .then((row) => requiredDatabaseValue(row)),
            ).toMatchObject({
                status: 'running',
                finishedAt: null,
            });
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbRunEvents)
                    .where(
                        and(
                            eq(dbRunEvents.runId, seed.run.id),
                            eq(dbRunEvents.type, 'report.published'),
                        ),
                    )
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        } finally {
            await fixture.db.execute(sql.raw('DROP TRIGGER fail_delivery_inbox ON inbox_items'));
            await fixture.db.execute(sql.raw('DROP FUNCTION fail_delivery_inbox()'));
        }
        expect((await delivery.deliver(seed.claimed.token, seed.candidate)).reused).toBe(false);
    });

    it('deadline仅使用截止前成功正文，不再调用provider，确定性partial可交付', async () => {
        const seed = await research();
        await fixture.db
            .update(dbRuns)
            .set({ deadlineAt: new Date(Date.now() - 1) })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const partial = (await seed.session.partial())!;
        expect(partial.coverage.exhausted).toContain('time');
        const forged = structuredClone(partial);
        forged.claims[0].citations[0].quote = '截止后伪造的引用';
        await expect(delivery.deliver(seed.claimed.token, forged, true)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(seed.run.id);
        // A stale or fabricated completeness flag cannot override the domain projection.
        partial.coverage = {
            completeness: 'complete',
            searchedQueries: [],
            gaps: [],
            exhausted: [],
        };
        const result = await delivery.deliver(seed.claimed.token, partial, true);
        expect(
            await fixture.db.query.reports
                .findFirst({ where: eq(dbReports.id, result.reportId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ completeness: 'partial' });
        expect(
            await fixture.db.query.runs
                .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({
            status: 'partial',
            outcome: 'inconclusive',
            coverageJson: { completeness: 'partial', exhausted: ['time'] },
        });
    });

    it('deadline拒绝截止后才确认的正文，取消后也不能走partial交付', async () => {
        const seed = await research();
        const partial = await seed.session.partial();
        expect(partial).not.toBeNull();
        await fixture.db
            .update(dbRuns)
            .set({ deadlineAt: new Date(0) })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await expect(delivery.deliver(seed.claimed.token, partial!, true)).rejects.toMatchObject({
            code: 'NO_EVIDENCE',
        });
        await fixture.db
            .update(dbRuns)
            .set({ status: 'cancel_requested', cancelRequestedAt: new Date() })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await expect(delivery.deliver(seed.claimed.token, partial!, true)).rejects.toMatchObject({
            code: 'RUN_CANCELED',
        });
        await assertEmpty(seed.run.id);
    });
}
