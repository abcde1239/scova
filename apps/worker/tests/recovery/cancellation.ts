import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    runs as dbRuns,
    eq,
    toolCalls as dbToolCalls,
    reports as dbReports,
    count as dbCount,
    asc,
} from '@scova/db';
import { createConnectorBundle, DEMO_URL } from '@scova/connectors';
import { expect, it } from 'vite-plus/test';
import { setup, usage, search, fixture, expireAfterEvidence, sessionFixture } from './fixture.ts';

export function registerCancellation() {
    it.each(['cancel', 'deadline'] as const)(
        'C14-ERR02 %s 后不预留或结算，deadline 仅可读取已存正文',
        async (reason) => {
            const seed = await setup();
            const page = await seed.repo.reserve({
                operationKey: 'read:1',
                tool: 'read',
                reserved: usage({ pages: 1 }),
            });
            const storedPage = { kind: 'read_page', text: 'saved evidence' };
            await seed.repo.settle({ toolCallId: page.toolCallId, output: storedPage });
            const pending = await seed.repo.reserve(search('pending'));
            if (reason === 'cancel')
                await fixture.db
                    .update(dbRuns)
                    .set({ cancelRequestedAt: new Date(), status: 'cancel_requested' })
                    .where(eq(dbRuns.id, seed.run.id))
                    .returning()
                    .then((rows) => requiredDatabaseValue(rows[0]));
            else await expireAfterEvidence(seed.run.id);
            const code = reason === 'cancel' ? 'RUN_CANCELED' : 'DEADLINE_EXCEEDED';
            await expect(seed.repo.reserve(search('forbidden'))).rejects.toMatchObject({ code });
            await expect(
                seed.repo.settle({ toolCallId: pending.toolCallId, output: { late: true } }),
            ).rejects.toMatchObject({ code });
            await expect(seed.repo.readPages()).rejects.toMatchObject({ code });
            await expect(seed.repo.comparison()).rejects.toMatchObject({ code });
            if (reason === 'deadline') {
                expect(await seed.repo.comparison({ allowDeadline: true })).toMatchObject({
                    comparisonScopeHash: seed.run.comparisonScopeHash,
                    feedback: { userId: seed.user.id, taskId: seed.task.id, items: [] },
                });
            } else {
                await expect(seed.repo.comparison({ allowDeadline: true })).rejects.toMatchObject({
                    code,
                });
            }
            if (reason === 'deadline')
                expect(await seed.repo.readPages({ allowDeadline: true })).toEqual([storedPage]);
            else
                await expect(seed.repo.readPages({ allowDeadline: true })).rejects.toMatchObject({
                    code,
                });
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbToolCalls)
                    .where(eq(dbToolCalls.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(2);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbReports)
                    .where(eq(dbReports.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(0);
        },
    );

    it.each(['cancel', 'deadline'] as const)(
        'C14-ERR04 session %s 后 search/read/model 均不得进入 provider，partial 仅使用已存正文',
        async (reason) => {
            const seed = await setup();
            const base = createConnectorBundle();
            const counts = { search: 0, read: 0, model: 0 };
            const { session, close } = sessionFixture(seed, {
                ...base,
                search: {
                    async search(query, options) {
                        counts.search++;
                        return base.search.search(query, options);
                    },
                },
                reader: {
                    async read(url, options) {
                        counts.read++;
                        return base.reader.read(url, options);
                    },
                },
                model: {
                    async generateStructured() {
                        counts.model++;
                        throw new Error('Model must not be called');
                    },
                },
            });
            try {
                await session.tools.read('saved', DEMO_URL);
                if (reason === 'cancel')
                    await fixture.db
                        .update(dbRuns)
                        .set({ cancelRequestedAt: new Date(), status: 'cancel_requested' })
                        .where(eq(dbRuns.id, seed.run.id))
                        .returning()
                        .then((rows) => requiredDatabaseValue(rows[0]));
                else await expireAfterEvidence(seed.run.id);
                const code = reason === 'cancel' ? 'RUN_CANCELED' : 'DEADLINE_EXCEEDED';
                await expect(
                    session.tools.search('forbidden-search', 'query'),
                ).rejects.toMatchObject({
                    code,
                });
                await expect(session.tools.read('forbidden-read', DEMO_URL)).rejects.toMatchObject({
                    code,
                });
                await expect(
                    session.tools.model('forbidden-model', {
                        prompt: 'must not leave worker',
                        schema: {},
                        maxInputTokens: 1,
                        maxOutputTokens: 1,
                    }),
                ).rejects.toMatchObject({ code });
                if (reason === 'deadline') {
                    const partial = await session.partial();
                    expect(partial).toMatchObject({
                        mode: 'demo',
                        comparison: 'not_performed',
                        coverage: { completeness: 'partial', exhausted: ['time'] },
                        pages: [expect.objectContaining({ kind: 'read_page', url: DEMO_URL })],
                    });
                } else await expect(session.partial()).rejects.toMatchObject({ code });
                expect(counts).toEqual({ search: 0, read: 1, model: 0 });
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbToolCalls)
                        .where(eq(dbToolCalls.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(1);
                expect(
                    await fixture.db
                        .select({ count: dbCount() })
                        .from(dbReports)
                        .where(eq(dbReports.runId, seed.run.id))
                        .then((rows) => rows[0]!.count),
                ).toBe(0);
            } finally {
                await close();
            }
        },
    );

    it('C14-ST04 provider 内重试每次独立收费；成功同key复用且超预算不进入provider', async () => {
        const seed = await setup();
        await fixture.db
            .update(dbRuns)
            .set({ budgetJson: { ...seed.config.budget, maxSearches: 2 } })
            .where(eq(dbRuns.id, seed.run.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        const base = createConnectorBundle();
        let externalAttempts = 0;
        const { session, close } = sessionFixture(seed, {
            ...base,
            search: {
                async search(query, options) {
                    for (let i = 0; i < 2; i++) {
                        await options?.beforeAttempt?.('search');
                        externalAttempts++;
                    }
                    return base.search.search(query, { ...options, beforeAttempt: undefined });
                },
            },
        });
        try {
            const result = await session.tools.search('retry-provider', 'same-input');
            expect(await session.tools.search('retry-provider', 'same-input')).toEqual(result);
            expect(externalAttempts).toBe(2);
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
                orderBy: [asc(dbToolCalls.attemptNo)],
            });
            expect(
                calls.map((call) => ({ attemptNo: call.attemptNo, status: call.status })),
            ).toEqual([
                { attemptNo: 1, status: 'unknown' },
                { attemptNo: 2, status: 'succeeded' },
            ]);
            expect(await seed.repo.usage()).toMatchObject({ searches: 2 });
            await expect(
                session.tools.search('retry-provider', 'different-input'),
            ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
            expect(externalAttempts).toBe(2);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbToolCalls)
                    .where(eq(dbToolCalls.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(2);
        } finally {
            await close();
        }
    });
}
