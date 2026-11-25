import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
    closeDatabase,
    eq,
    projectTasks,
    projects,
    reports,
    runs,
    taskVersions,
    toolCalls,
} from '@scova/db';
import { createSqliteDatabaseClient } from '@scova/db/sqlite';
import { readLocalSqlitePaths } from '../src/app/sqlite-local.ts';
import {
    endAgent,
    launchAgent,
    waitAgentMessage,
} from '../../worker/tests/recovery/process-fixture.ts';
import { expect, it } from 'vite-plus/test';
import { createExecutionClient } from '../../worker/src/repo/execution.ts';
import { seedRun } from '../../worker/tests/support/run-database.ts';
import { testWorkerExecution } from '../../worker/tests/support/worker-execution.ts';
import { createLibraryRepo } from '../src/repo/library.ts';
import { createProjectEvidenceStore } from '../src/repo/project-evidence.ts';
import { libraryFixture } from './support/library.ts';

it('selects full SQLite only when two local paths are explicitly configured', () => {
    const business = join(tmpdir(), 'business.sqlite');
    const state = join(tmpdir(), 'state.sqlite');
    const env = { SCOVA_SQLITE_DATABASE_PATH: business, SCOVA_SQLITE_STATE_PATH: state };
    expect(readLocalSqlitePaths({})).toBeUndefined();
    expect(
        readLocalSqlitePaths({
            DATABASE_URL: 'postgresql://localhost/test',
            SCOVA_SQLITE_STATE_PATH: state,
        }),
    ).toBeUndefined();
    expect(readLocalSqlitePaths(env)).toEqual({ business, state });
    expect(() => readLocalSqlitePaths({ ...env, SCOVA_SQLITE_STATE_PATH: undefined })).toThrow(
        'SCOVA_SQLITE_STATE_PATH',
    );
    expect(() => readLocalSqlitePaths({ ...env, SCOVA_SQLITE_STATE_PATH: business })).toThrow(
        'SCOVA_SQLITE_STATE_PATH',
    );
    expect(() =>
        readLocalSqlitePaths({ ...env, SCOVA_SQLITE_DATABASE_PATH: 'business.sqlite' }),
    ).toThrow('SCOVA_SQLITE_DATABASE_PATH');
    expect(() =>
        readLocalSqlitePaths({ ...env, DATABASE_URL: 'postgresql://localhost/test' }),
    ).toThrow('DATABASE_URL');
    expect(() => readLocalSqlitePaths({ ...env, REDIS_URL: 'redis://localhost' })).toThrow(
        'REDIS_URL',
    );
});

const graph = new StateGraph(Annotation.Root({ value: Annotation<string>() }))
    .addNode('record', () => ({ value: 'approved' }))
    .addEdge(START, 'record')
    .addEdge('record', END);

it('reopens reports and rejects stale checkpoint writes after a Run is reclaimed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'scova-sqlite-local-'));
    const path = join(directory, 'business.sqlite');
    const statePath = join(directory, 'state.sqlite');
    const env = { SCOVA_SQLITE_DATABASE_PATH: path, SCOVA_SQLITE_STATE_PATH: statePath };
    let database = createSqliteDatabaseClient(path);
    let server: Awaited<ReturnType<typeof testWorkerExecution>> | undefined;
    try {
        const seed = await seedRun(database, { mode: 'live' });
        const report = await libraryFixture(database, seed.user.id, {
            id: seed.task.id,
            currentVersionId: seed.version.id,
        });
        const [project] = await database
            .insert(projects)
            .values({ userId: seed.user.id, name: 'Local' })
            .returning();
        await database
            .insert(projectTasks)
            .values({ userId: seed.user.id, taskId: seed.task.id, projectId: project.id });
        server = await testWorkerExecution(database, env);
        let client = createExecutionClient(server.url, server.token);
        expect((await client.ready()).queue).toBe('sqlite');
        const first = await client.runs.claim(seed.run.id, 'first', 60_000);
        if (first.kind !== 'claimed') throw new Error(`Expected first claim, got ${first.kind}`);
        const saver = client.persistence.checkpoints(first.token);
        const compiled = graph.compile({ checkpointer: saver });
        const config = {
            configurable: {
                thread_id: `run-${seed.run.id}-epoch-${first.token.leaseEpoch}`,
                checkpoint_ns: '',
            },
        };
        await compiled.invoke({ value: 'initial' }, config);
        const tuple = await saver.getTuple(config);
        expect(tuple?.checkpoint.channel_values.value).toBe('approved');
        if (!tuple) throw new Error('Expected a saved checkpoint');
        await saver.putWrites(tuple.config, [['value', 'pending']], 'first-write');
        const ref = {
            threadId: config.configurable.thread_id,
            namespace: '' as const,
            checkpointId: tuple.checkpoint.id,
            leaseEpoch: first.token.leaseEpoch,
        };
        await client.persistence.repository(first.token).promoteCheckpoint(ref);
        await database
            .update(runs)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(runs.id, seed.run.id));
        await server.stop();
        server = undefined;
        await closeDatabase(database);
        database = createSqliteDatabaseClient(path);
        server = await testWorkerExecution(database, env);
        client = createExecutionClient(server.url, server.token);
        const second = await client.runs.claim(seed.run.id, 'second', 60_000);
        if (second.kind !== 'claimed') throw new Error(`Expected recovery, got ${second.kind}`);
        expect(second.token.leaseEpoch).toBe(first.token.leaseEpoch + 1);
        expect(second.run.deadlineAt).toEqual(first.run.deadlineAt);
        await expect(
            client.persistence.repository(second.token).readAuthorizedCheckpoint(),
        ).resolves.toEqual(ref);
        const recovered = await client.persistence.checkpoints(second.token).getTuple(tuple.config);
        expect(recovered?.checkpoint.channel_values.value).toBe('approved');
        expect(recovered?.pendingWrites).toContainEqual(['first-write', 'value', 'pending']);
        await expect(
            client.persistence
                .checkpoints(first.token)
                .putWrites(tuple.config, [['value', 'stale']], 'stale-write'),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });

        const library = createLibraryRepo({ db: () => database });
        const bookmark = await library.createBookmark(seed.user.id, report.source.id);
        await expect(library.bookmark(seed.user.id, bookmark.id)).resolves.toMatchObject({
            latestSnapshotId: report.snapshot.id,
            lastObservedAt: expect.any(Date),
        });
        await expect(
            library.snapshot(seed.user.id, report.source.id, report.snapshot.id),
        ).resolves.toMatchObject({ metadata: { mode: 'demo' }, bodyAvailable: true });
        await expect(
            library.search(seed.user.id, { q: 'robotics' }, ['robotics'], 5),
        ).resolves.toEqual([
            expect.objectContaining({
                snapshotId: report.snapshot.id,
                matchedBy: 'substring',
                updatedAt: expect.any(Date),
            }),
        ]);
        const evidence = createProjectEvidenceStore(database, seed.user.id, project.id);
        await expect(evidence.search('小样本', 5)).resolves.toEqual([
            expect.objectContaining({
                id: report.report.id,
                matchingSource: expect.objectContaining({ snapshotId: report.snapshot.id }),
            }),
        ]);
    } finally {
        await server?.stop();
        await closeDatabase(database);
        for (const file of [path, statePath]) {
            for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
        }
        rmdirSync(directory);
    }
});

it('replays a committed tool call after a Worker crash and delivers a report on SQLite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'scova-sqlite-recovery-'));
    const path = join(directory, 'business.sqlite');
    const statePath = join(directory, 'state.sqlite');
    const database = createSqliteDatabaseClient(path);
    let server: Awaited<ReturnType<typeof testWorkerExecution>> | undefined;
    let first: ReturnType<typeof launchAgent> | undefined;
    let second: ReturnType<typeof launchAgent> | undefined;
    try {
        const seed = await seedRun(database);
        const budget = { ...seed.config.budget, maxSearches: 1, maxPages: 1 };
        await database
            .update(taskVersions)
            .set({ configJson: { ...seed.config, budget, focusPoints: [] } })
            .where(eq(taskVersions.id, seed.version.id));
        await database.update(runs).set({ budgetJson: budget }).where(eq(runs.id, seed.run.id));
        server = await testWorkerExecution(database, {
            SCOVA_SQLITE_DATABASE_PATH: path,
            SCOVA_SQLITE_STATE_PATH: statePath,
        });
        first = launchAgent('node', 'crash', seed.run.id, 'read', server);
        await waitAgentMessage(first, 'settled-before-checkpoint');
        await endAgent(first, true);
        const initial = await database.query.runs.findFirst({ where: eq(runs.id, seed.run.id) });
        expect(initial?.usageJson).toMatchObject({ searches: 1, pages: 1 });
        await database
            .update(runs)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(runs.id, seed.run.id));
        second = launchAgent('node', 'resume', seed.run.id, 'read', server, { deliver: true });
        await waitAgentMessage(second, 'candidate');
        await endAgent(second);
        expect(second.exit?.code, second.output).toBe(0);
        expect(second.messages.filter((message) => message.type === 'connector')).toEqual([]);
        const calls = await database.query.toolCalls.findMany({
            where: eq(toolCalls.runId, seed.run.id),
        });
        expect(calls).toHaveLength(2);
        expect(
            calls.every(({ status, attemptNo }) => status === 'succeeded' && attemptNo === 1),
        ).toBe(true);
        const recovered = await database.query.runs.findFirst({ where: eq(runs.id, seed.run.id) });
        expect(recovered?.leaseEpoch).toBe(initial!.leaseEpoch + 1);
        const reportId = second.messages.find((message) => message.type === 'report')?.reportId;
        expect(reportId).toBeDefined();
        await expect(
            database.query.reports.findFirst({ where: eq(reports.id, reportId!) }),
        ).resolves.toMatchObject({ runId: seed.run.id, userId: seed.user.id });
    } finally {
        if (first && !first.exit) await endAgent(first, true);
        if (second && !second.exit) await endAgent(second, true);
        await server?.stop();
        await closeDatabase(database);
        for (const file of [path, statePath]) {
            for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
        }
        rmdirSync(directory);
    }
}, 40_000);
