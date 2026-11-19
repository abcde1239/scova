import { expect, it } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { runs as dbRuns, eq, reportSearchConfigurationHash, searchConfigurations } from '@scova/db';
import { createConnectorBundle } from '@scova/connectors';
import { createAgentRuntime } from '../src/service/agent.ts';
import { prepareTestCheckpointSchema } from './support/checkpoint-schema.ts';
import { freezeSearchConfiguration } from '../src/repo/search-configuration-freeze.ts';
import { fixture, setup, takeover, usage } from './recovery/fixture.ts';

it('冻结自定义源身份并跨租约恢复，改配置或移除源不会静默改路由', async () => {
    const seed = await setup({ mode: 'live' });
    const hash = 'b'.repeat(64);
    await freezeSearchConfiguration(fixture.db, seed.current.token, hash);
    const row = await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) });
    expect(row?.searchConfigurationHash).toBe(hash);
    const next = await takeover(seed.run.id);
    await expect(
        freezeSearchConfiguration(fixture.db, next.current.token, hash),
    ).resolves.toBeUndefined();
    for (const changed of ['c'.repeat(64), null])
        await expect(
            freezeSearchConfiguration(fixture.db, next.current.token, changed),
        ).rejects.toMatchObject({ code: 'SEARCH_CONFIGURATION_CHANGED' });
    await expect(
        freezeSearchConfiguration(fixture.db, seed.current.token, hash),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
});

it('历史执行有 checkpoint 时不自动采用新的自定义服务', async () => {
    const seed = await setup({ mode: 'live' });
    await fixture.db
        .update(dbRuns)
        .set({ checkpointRef: { historical: true } })
        .where(eq(dbRuns.id, seed.run.id));
    await expect(
        freezeSearchConfiguration(fixture.db, seed.current.token, 'b'.repeat(64)),
    ).rejects.toMatchObject({ code: 'SEARCH_CONFIGURATION_CHANGED' });
});

it('首次 checkpoint 前已有工具操作的执行也不能更换为自定义源', async () => {
    const seed = await setup({ mode: 'live' });
    await seed.repo.reserve({
        operationKey: 'old-search:identity',
        tool: 'search',
        reserved: usage({ searches: 1 }),
    });
    await expect(
        freezeSearchConfiguration(fixture.db, seed.current.token, 'b'.repeat(64)),
    ).rejects.toMatchObject({ code: 'SEARCH_CONFIGURATION_CHANGED' });
});

it('历史内置协议继续不使用新身份，不改写原运行或工具身份', async () => {
    const seed = await setup({ mode: 'live' });
    await expect(
        freezeSearchConfiguration(fixture.db, seed.current.token, null),
    ).resolves.toBeUndefined();
    const row = await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) });
    expect(row?.searchConfigurationHash).toBeNull();
});

it('confirmed account API identity must match before the first provider call or recovery', async () => {
    const seed = await setup({ mode: 'live' });
    const owner = seed.run.userId;
    const [record] = await fixture.db
        .insert(searchConfigurations)
        .values({
            userId: owner,
            defaultMode: 'api',
            revision: 3,
            protocol: 'tavily',
            baseUrl: 'https://search.example.test/',
            contentMode: 'prefer_api',
            encryptedApiKey: 'fixture-ciphertext',
        })
        .returning();
    const frozen = reportSearchConfigurationHash(record!);
    await fixture.db
        .update(dbRuns)
        .set({ searchConfigurationHash: frozen })
        .where(eq(dbRuns.id, seed.run.id));
    let providerCalls = 0;
    const provider = async (): Promise<never> => {
        providerCalls++;
        throw new Error('Unexpected provider call');
    };
    const runtime = createAgentRuntime({
        database: fixture.db,
        databaseUrl: fixture.databaseUrl,
        checkpointSchema: fixture.checkpointSchema,
        bundle: {
            ...createConnectorBundle(),
            mode: 'live',
            search: { search: provider },
            reader: { read: provider },
            model: { generateStructured: provider },
        },
    });
    const context = {
        runId: seed.run.id,
        userId: owner,
        taskId: seed.run.taskId,
        taskVersionId: seed.run.taskVersionId,
        mode: 'live' as const,
        config: { ...seed.current.config, searchMode: 'api' as const },
        budget: seed.current.budget,
        usage: seed.current.usage,
        deadlineAt: seed.current.run.deadlineAt!,
        signal: new AbortController().signal,
        assertActive: async () => {},
        emit: async () => {},
        conversation: {
            version: 1 as const,
            operation: 'research' as const,
            reportId: randomUUID(),
            questionId: randomUUID(),
            report: { title: 'Test report', summary: '', claims: [] },
            messages: [],
            sources: [],
            omittedTurns: 0,
            searchSelection: { searchMode: 'api' as const, searchConfigRevision: 3 },
        },
    };
    try {
        await prepareTestCheckpointSchema(fixture.databaseUrl, fixture.checkpointSchema);
        await runtime.connect();
        // A replacement at the same revision still has a different credential identity.
        await fixture.db
            .update(searchConfigurations)
            .set({ encryptedApiKey: 'replacement' })
            .where(eq(searchConfigurations.userId, owner));
        await expect(
            runtime.executorFactory(seed.current.token).execute(context),
        ).rejects.toMatchObject({ code: 'SEARCH_CONFIGURATION_CHANGED' });
        const recovered = await takeover(seed.run.id);
        await fixture.db.delete(searchConfigurations).where(eq(searchConfigurations.userId, owner));
        await expect(
            runtime.executorFactory(recovered.current.token).execute(context),
        ).rejects.toMatchObject({ code: 'SEARCH_CONFIGURATION_CHANGED' });
        expect(providerCalls).toBe(0);
        expect(
            await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) }),
        ).toMatchObject({ searchConfigurationHash: frozen });
    } finally {
        await runtime.close();
    }
});
