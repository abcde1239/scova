import { randomBytes, randomUUID } from 'node:crypto';
import {
    claims,
    eq,
    projectSettings,
    projectTasks,
    projectThreads,
    projects,
    reports,
    sessions,
    sourceSnapshots,
    tasks,
    taskVersions,
    users,
} from '@scova/db';
import {
    PROJECT_SETTINGS_REQUIREMENTS_LIMIT,
    type ProjectSettings,
    type ProjectReportEvidenceSearch,
    type ProjectSourceEvidence,
} from '@scova/models';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApiApp } from '@/app/index.ts';
import { createDefaultServices } from '@/app/services.ts';
import { appendProjectThreadItems } from '@/repo/project-threads.ts';
import { buildProjectEvidenceContext } from '@/service/project-evidence.ts';
import { csrfForSession, tokenHash } from '@/utils/security.ts';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { libraryFixture } from './support/library.ts';

const fixture = outboxDatabase();
const { db } = fixture;
const origin = 'https://scova.test';
const services = createDefaultServices({ db: () => db, origin });
const app = createApiApp('node', services);

beforeAll(() => fixture.setup(), 90_000);
afterAll(async () => {
    try {
        await services.close();
    } finally {
        await fixture.cleanup();
    }
});

async function seedOwner() {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    await db
        .insert(users)
        .values({ id: userId, email, normalizedEmail: email, passwordHash: 'fixture' });
    const token = randomBytes(32).toString('base64url');
    const csrf = csrfForSession(token);
    await db.insert(sessions).values({
        userId,
        tokenHash: tokenHash(token),
        csrfTokenHash: tokenHash(csrf),
        expiresAt: new Date(Date.now() + 600_000),
    });
    return { userId, token, csrf };
}

type Owner = Awaited<ReturnType<typeof seedOwner>>;

function request(projectId: string, path: string, owner?: Owner, body?: unknown, csrf = true) {
    const headers = new Headers({ origin });
    if (owner) {
        headers.set('cookie', `scova_session=${owner.token}`);
        if (csrf) headers.set('x-csrf-token', owner.csrf);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.handle(
        new Request(`${origin}/api/v1/projects/${projectId}${path}`, {
            headers,
            method: body === undefined ? 'GET' : 'PATCH',
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
}

async function json<T>(response: Response, status = 200): Promise<T> {
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body as T;
}

async function seedProject(userId: string) {
    const [project] = await db
        .insert(projects)
        .values({ userId, name: 'Evidence project' })
        .returning();
    return project!.id;
}

async function seedReport(
    userId: string,
    projectId: string,
    title: string,
    snapshotTitle = 'Source title',
) {
    const [task] = await db.insert(tasks).values({ userId, title }).returning();
    const [version] = await db
        .insert(taskVersions)
        .values({
            userId,
            taskId: task!.id,
            version: 1,
            configJson: {},
            comparisonScopeHash: 'a'.repeat(64),
        })
        .returning();
    await db.insert(projectTasks).values({ userId, taskId: task!.id, projectId });
    const { report, snapshot } = await libraryFixture(
        db,
        userId,
        { id: task!.id, currentVersionId: version!.id },
        { title: snapshotTitle, text: 'text '.repeat(600) },
    );
    await db.update(reports).set({ title }).where(eq(reports.id, report.id));
    return { report, snapshot, taskId: task!.id };
}

const searchPath = '/evidence/reports';
const settingsPath = '/settings';
const reportPath = (id: string) => `${searchPath}/${id}`;
const sourcePath = (reportId: string, snapshotId: string) =>
    `${reportPath(reportId)}/sources/${snapshotId}`;

describe('project settings and scoped evidence', () => {
    it('reads defaults, validates mutations and keeps concurrent disjoint patches', async () => {
        const owner = await seedOwner();
        const other = await seedOwner();
        const projectId = await seedProject(owner.userId);
        const response = await request(projectId, settingsPath, owner);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await json<ProjectSettings>(response)).toEqual({
            projectId,
            goal: '',
            requirements: '',
            preferredSources: [],
            defaultAutonomy: 'budgeted',
            updatedAt: null,
        });
        expect(
            await db.select().from(projectSettings).where(eq(projectSettings.projectId, projectId)),
        ).toEqual([]);
        await json(await request(projectId, settingsPath), 401);
        await json(await request(projectId, settingsPath, other), 404);
        await json(await request(projectId, settingsPath, other, { goal: 'other' }), 404);
        await json(await request(projectId, settingsPath, owner, { goal: 'csrf' }, false), 403);
        for (const invalid of [
            {},
            { requirements: 'x'.repeat(PROJECT_SETTINGS_REQUIREMENTS_LIMIT + 1) },
            { preferredSources: ['file:///private'] },
            { preferredSources: ['https://user:pw@example.com'] },
            { defaultAutonomy: 'unsupported' },
        ]) {
            await json(await request(projectId, settingsPath, owner, invalid), 422);
        }
        await Promise.all([
            request(projectId, settingsPath, owner, { goal: 'Track changes' }).then((res) =>
                json(res),
            ),
            request(projectId, settingsPath, owner, {
                requirements: 'Use original sources',
                preferredSources: ['https://example.com/docs'],
                defaultAutonomy: 'ask',
            }).then((res) => json(res)),
        ]);
        expect(
            await json<ProjectSettings>(await request(projectId, settingsPath, owner)),
        ).toMatchObject({
            goal: 'Track changes',
            requirements: 'Use original sources',
            defaultAutonomy: 'ask',
            preferredSources: ['https://example.com/docs'],
        });
    });

    it('finds literal matches in reports, claims and source titles without crossing projects', async () => {
        const owner = await seedOwner();
        const other = await seedOwner();
        const projectId = await seedProject(owner.userId);
        const empty = await seedProject(owner.userId);
        const sibling = await seedProject(owner.userId);
        const otherProject = await seedProject(other.userId);
        const [{ report: title }, { report: withClaim, taskId }, { report: withSource, snapshot }] =
            await Promise.all([
                seedReport(owner.userId, projectId, '电池 100% 研究'),
                seedReport(owner.userId, projectId, 'Results'),
                seedReport(owner.userId, projectId, 'Source evidence', '电池 100% 来源'),
                seedReport(owner.userId, sibling, '电池 100% private sibling'),
                seedReport(other.userId, otherProject, '电池 100% private owner'),
            ]);
        await db.insert(claims).values({
            userId: owner.userId,
            taskId,
            reportId: withClaim.id,
            kind: 'fact',
            confidenceLabel: 'high',
            order: 1,
            text: '电池 100% 结论',
        });
        const path = `${searchPath}?q=${encodeURIComponent('电池 100%')}`;
        expect(await json<ProjectReportEvidenceSearch>(await request(empty, path, owner))).toEqual({
            items: [],
        });
        const results = await json<ProjectReportEvidenceSearch>(
            await request(projectId, path, owner),
        );
        expect(results.items).toHaveLength(3);
        expect(results.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: title.id,
                    matchingClaim: null,
                    matchingSource: null,
                }),
                expect.objectContaining({
                    id: withClaim.id,
                    matchingClaim: '电池 100% 结论',
                    matchingSource: null,
                }),
                expect.objectContaining({
                    id: withSource.id,
                    matchingClaim: null,
                    matchingSource: expect.objectContaining({ snapshotId: snapshot.id }),
                }),
            ]),
        );
        expect(
            (
                await json<ProjectReportEvidenceSearch>(
                    await request(projectId, `${path}&limit=1`, owner),
                )
            ).items,
        ).toHaveLength(1);
        await json(await request(projectId, `${path}&limit=11`, owner), 422);
        await json(await request(projectId, path, other), 404);
        expect(
            (
                await json<ProjectReportEvidenceSearch>(
                    await request(projectId, `${searchPath}?q=_`, owner),
                )
            ).items,
        ).toEqual([]);
    });

    it('binds snapshots to an observed report, respects text expiry and revokes access after a move', async () => {
        const owner = await seedOwner();
        const other = await seedOwner();
        const projectId = await seedProject(owner.userId);
        const target = await seedProject(owner.userId);
        const [{ report, snapshot, taskId }, { snapshot: foreignSnapshot }] = await Promise.all([
            seedReport(owner.userId, projectId, 'Report'),
            seedReport(owner.userId, projectId, 'Other report'),
        ]);
        const path = sourcePath(report.id, snapshot.id);
        const source = await json<ProjectSourceEvidence>(await request(projectId, path, owner));
        expect(source).toMatchObject({ reportId: report.id, snapshotId: snapshot.id });
        expect(source.excerpt?.length).toBe(2_400);
        await json(await request(projectId, sourcePath(report.id, foreignSnapshot.id), owner), 404);
        await json(await request(projectId, path, other), 404);
        await db
            .update(sourceSnapshots)
            .set({ textExpiresAt: new Date(0) })
            .where(eq(sourceSnapshots.id, snapshot.id));
        expect(
            (await json<ProjectSourceEvidence>(await request(projectId, path, owner))).excerpt,
        ).toBeNull();
        await db
            .update(projectTasks)
            .set({ projectId: target })
            .where(eq(projectTasks.taskId, taskId));
        await json(await request(projectId, reportPath(report.id), owner), 404);
        await json(await request(projectId, path, owner), 404);
        await json(await request(target, path, owner));
    });

    it('injects bounded settings and only complete authorized history provenance', async () => {
        const { userId } = await seedOwner();
        const projectId = await seedProject(userId);
        const sibling = await seedProject(userId);
        const [thread] = await db
            .insert(projectThreads)
            .values({ projectId, userId, title: 'Chat' })
            .returning();
        const assignments = await Promise.all(
            Array.from({ length: 13 }, (_, i) => seedReport(userId, projectId, `Provenance ${i}`)),
        );
        const refs = assignments.map(({ report }) => ({ kind: 'report', id: report.id }));
        const now = new Date();
        await db.insert(projectSettings).values({
            userId,
            projectId,
            goal: 'Context goal',
            requirements: 'x'.repeat(PROJECT_SETTINGS_REQUIREMENTS_LIMIT),
        });
        await db.transaction((tx) =>
            appendProjectThreadItems(
                tx,
                userId,
                thread!.id,
                [
                    { kind: 'message', payload: { role: 'user', text: 'question' } },
                    {
                        kind: 'message',
                        payload: { role: 'assistant', text: 'overflows' },
                        refs: [refs[12]!],
                    },
                    {
                        kind: 'message',
                        payload: { role: 'assistant', text: 'kept'.repeat(160) },
                        refs: refs.slice(0, 12),
                    },
                ],
                now,
            ),
        );
        const input = {
            threadId: thread!.id,
            sourceRefs: [
                { reportId: assignments[0]!.report.id, snapshotId: assignments[0]!.snapshot.id },
            ],
        };
        const context = await buildProjectEvidenceContext(db, userId, projectId, input, now);
        expect(context.settings).toMatchObject({
            goal: 'Context goal',
            requirements: 'x'.repeat(PROJECT_SETTINGS_REQUIREMENTS_LIMIT),
        });
        expect(context.sources).toHaveLength(1);
        expect(context.reportRefs).toEqual(refs.slice(0, 12));
        expect(context.history).toEqual([
            { role: 'user', text: 'question' },
            { role: 'assistant', text: 'kept'.repeat(100) },
        ]);
        await expect(
            buildProjectEvidenceContext(db, userId, sibling, input, now),
        ).rejects.toMatchObject({ status: 404 });
        await db
            .update(projectTasks)
            .set({ projectId: sibling })
            .where(eq(projectTasks.taskId, assignments[0]!.taskId));
        await expect(
            buildProjectEvidenceContext(db, userId, projectId, input, now),
        ).rejects.toMatchObject({ status: 404 });
        const redacted = await buildProjectEvidenceContext(
            db,
            userId,
            projectId,
            { threadId: thread!.id },
            now,
        );
        expect(redacted.history.map(({ text }) => text)).toEqual(['question', 'overflows']);
        expect(redacted.reportRefs).toEqual([refs[12]]);
    });
});
