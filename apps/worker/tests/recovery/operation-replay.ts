import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    runs as dbRuns,
    eq,
    toolCalls as dbToolCalls,
    runEvents as dbRunEvents,
    reports as dbReports,
    count as dbCount,
    asc,
} from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { setup, search, takeover, fixture, usage } from './fixture.ts';

export function registerOperationReplay() {
    it('C14-F01 已提交 operationKey 跨 epoch 复用，结算重放不改结果或重复扣费', async () => {
        const seed = await setup();
        const first = await seed.repo.reserve({
            ...search('search:1'),
            inputSummary: 'secret prompt',
        });
        const result = { kind: 'search_results', results: [{ url: 'https://example.com' }] };
        await seed.repo.settle({ toolCallId: first.toolCallId, output: result });
        await seed.repo.settle({ toolCallId: first.toolCallId, output: { overwritten: true } });
        const next = await takeover(seed.run.id);
        expect(await next.repo.reserve(search('search:1'))).toMatchObject({
            kind: 'reused',
            toolCallId: first.toolCallId,
            attemptNo: 1,
            output: result,
            usage: { searches: 1 },
        });
        const calls = await fixture.db.query.toolCalls.findMany({
            where: eq(dbToolCalls.runId, seed.run.id),
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.inputSummary).not.toContain('secret');
        const events = await fixture.db.query.runEvents.findMany({
            where: eq(dbRunEvents.runId, seed.run.id),
        });
        expect(JSON.stringify(events)).not.toContain('secret prompt');
        expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbReports)
                .where(eq(dbReports.runId, seed.run.id))
                .then((rows) => rows[0]!.count),
        ).toBe(0);
    });

    it.each([
        {
            tool: 'search',
            counter: 'searches',
            budget: 'maxSearches',
            reserved: usage({ searches: 1 }),
        },
        { tool: 'read', counter: 'pages', budget: 'maxPages', reserved: usage({ pages: 1 }) },
        {
            tool: 'model',
            counter: 'inputTokens',
            budget: 'maxInputTokens',
            reserved: usage({ inputTokens: 1, outputTokens: 1 }),
        },
        {
            tool: 'model',
            counter: 'outputTokens',
            budget: 'maxOutputTokens',
            reserved: usage({ inputTokens: 1, outputTokens: 1 }),
        },
    ] as const)(
        'C14-E01 并发预留 $counter 到上限后原子拒绝，不能超卖',
        async ({ tool, counter, budget, reserved }) => {
            const seed = await setup();
            await fixture.db
                .update(dbRuns)
                .set({ budgetJson: { ...seed.config.budget, [budget]: 2 } })
                .where(eq(dbRuns.id, seed.run.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            const results = await Promise.allSettled(
                Array.from({ length: 8 }, (_, i) =>
                    seed.repo.reserve({
                        operationKey: `${tool}:${i}`,
                        tool,
                        reserved,
                    }),
                ),
            );
            expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
            const rejected = results.filter((item) => item.status === 'rejected');
            expect(rejected).toHaveLength(6);
            for (const item of rejected)
                if (item.status === 'rejected')
                    expect(item.reason).toMatchObject({ code: 'BUDGET_EXCEEDED' });
            expect((await seed.repo.usage())[counter]).toBe(2);
            expect(
                await fixture.db
                    .select({ count: dbCount() })
                    .from(dbToolCalls)
                    .where(eq(dbToolCalls.runId, seed.run.id))
                    .then((rows) => rows[0]!.count),
            ).toBe(2);
            const events = await fixture.db.query.runEvents.findMany({
                where: eq(dbRunEvents.runId, seed.run.id),
                orderBy: [asc(dbRunEvents.seq)],
            });
            expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
            expect(events.filter((event) => event.type === 'budget.updated')).toHaveLength(2);
            expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
        },
    );

    it('C14-E02 同 operationKey 并发只有一个在途调用；工具类型不允许换用', async () => {
        const seed = await setup();
        const results = await Promise.allSettled(
            Array.from({ length: 5 }, () => seed.repo.reserve(search('same-operation'))),
        );
        expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
        for (const item of results)
            if (item.status === 'rejected')
                expect(item.reason).toMatchObject({ code: 'TOOL_CALL_BUSY' });
        await expect(
            seed.repo.reserve({
                operationKey: 'same-operation',
                tool: 'read',
                reserved: usage({ pages: 1 }),
            }),
        ).rejects.toMatchObject({ code: 'INVALID_TOOL_CALL' });
        expect(await seed.repo.usage()).toMatchObject({ searches: 1, pages: 0 });
    });

    it('工具失败持久化固定分类，仍保留未知结果和已预留预算', async () => {
        const seed = await setup();
        const held = await seed.repo.reserve(search('classified-failure'));
        await seed.repo.fail({ toolCallId: held.toolCallId, failureCode: 'TOOL_UNSAFE_URL' });
        const calls = await fixture.db.query.toolCalls.findMany({
            where: eq(dbToolCalls.runId, seed.run.id),
        });
        expect(calls[0]?.status).toBe('unknown');
        expect(await seed.repo.usage()).toMatchObject({ searches: 1 });
        const events = await fixture.db.query.runEvents.findMany({
            where: eq(dbRunEvents.runId, seed.run.id),
        });
        const failure = events.find((event) => event.type === 'tool.failed');
        expect(failure?.payload).toMatchObject({
            code: 'TOOL_UNSAFE_URL',
            severity: 'error',
            message: '地址或域名解析未通过公网安全校验',
            retryable: false,
        });
    });

    it('persists a skipped page warning without marking the whole execution failed', async () => {
        const seed = await setup();
        const held = await seed.repo.reserve({
            operationKey: 'page-warning',
            tool: 'read',
            reserved: usage({ pages: 1 }),
        });
        await seed.repo.fail({
            toolCallId: held.toolCallId,
            failureCode: 'TOOL_HTTP_NOT_FOUND',
            unknown: false,
        });
        const events = await fixture.db.query.runEvents.findMany({
            where: eq(dbRunEvents.runId, seed.run.id),
        });
        expect(events.find((event) => event.type === 'tool.failed')?.payload).toMatchObject({
            code: 'TOOL_HTTP_NOT_FOUND',
            severity: 'warning',
            retryable: false,
        });
        expect(events.some((event) => event.type === 'run.failed')).toBe(false);
        expect(await seed.repo.usage()).toMatchObject({ pages: 1 });
    });

    it.each([true, false])(
        'C14-ST01 unknown=%s 保留已预留预算，重试新 attempt 再收费',
        async (unknown) => {
            const seed = await setup();
            await fixture.db
                .update(dbRuns)
                .set({ budgetJson: { ...seed.config.budget, maxSearches: 2 } })
                .where(eq(dbRuns.id, seed.run.id))
                .returning()
                .then((rows) => requiredDatabaseValue(rows[0]));
            const first = await seed.repo.reserve(search('retry'));
            await seed.repo.fail({ toolCallId: first.toolCallId, unknown });
            expect(await seed.repo.usage()).toMatchObject({ searches: 1 });
            const second = await seed.repo.reserve(search('retry'));
            expect(second).toMatchObject({
                kind: 'reserved',
                attemptNo: 2,
                usage: { searches: 2 },
            });
            await seed.repo.fail({ toolCallId: second.toolCallId, unknown });
            await expect(seed.repo.reserve(search('retry'))).rejects.toMatchObject({
                code: 'BUDGET_EXCEEDED',
            });
            const calls = await fixture.db.query.toolCalls.findMany({
                where: eq(dbToolCalls.runId, seed.run.id),
                orderBy: [asc(dbToolCalls.attemptNo)],
            });
            expect(calls.map((call) => call.status)).toEqual([
                unknown ? 'unknown' : 'failed',
                unknown ? 'unknown' : 'failed',
            ]);
            expect(await seed.repo.usage()).toMatchObject({ searches: 2 });
        },
    );
}
