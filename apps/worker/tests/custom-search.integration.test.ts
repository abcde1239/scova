import { expect, it } from 'vite-plus/test';
import { runs as dbRuns, eq } from '@scova/db';
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
