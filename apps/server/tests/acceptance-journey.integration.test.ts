import { and, eq, isNotNull, count } from '@scova/db';
import * as tables from '@scova/db';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import {
    readFeedbackSnapshot,
    type Feedback,
    type Report,
    type ReportQuestion,
    type Run,
} from '@scova/models';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { historyFixture, type HistoryOwner } from './support/history-fixture.ts';
import { draftConfig } from './support/task-drafts.ts';
import { startAcceptanceWorker } from './support/acceptance-worker.ts';
import type { ScenarioPhase } from '../../worker/tests/support/acceptance-scenario-fixtures.ts';
import { requireRow } from '../src/utils/database.ts';

const fixture = historyFixture({ questionFixture: true });
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
beforeAll(() => fixture.setup(), 120_000);
afterAll(() => fixture.cleanup());
async function json<T>(
    path: string,
    owner: HistoryOwner,
    init?: RequestInit,
    status = 200,
): Promise<T> {
    const response = await fixture.request(path, owner, init);
    expect(response.status, path + ': ' + response.status).toBe(status);
    return (await response.json()) as T;
}
async function waitUntil(check: () => Promise<boolean>, description: () => string) {
    const deadline = Date.now() + 30_000;
    while (!(await check())) {
        if (Date.now() >= deadline) throw new Error('Journey timeout: ' + description());
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
async function deliver(
    runId: string,
    phase: ScenarioPhase,
    queueName: string,
    owner: HistoryOwner,
) {
    const worker = await startAcceptanceWorker({
        databaseUrl: fixture.databaseUrl,
        redisUrl,
        name: 'english',
        phase,
        queueName,
        queryForGoal: true,
    });
    try {
        await waitUntil(
            async () => {
                const row = await fixture.db.query.runs
                    .findFirst({ where: and(eq(tables.runs.id, runId)) })
                    .then(requireRow);
                if (
                    row.status === 'failed' ||
                    row.status === 'canceled' ||
                    row.status === 'partial'
                )
                    throw new Error(
                        'Journey production Run did not complete: ' +
                            row.failureCode +
                            ' ' +
                            JSON.stringify(row.coverageJson) +
                            ' ' +
                            worker.output(),
                    );
                return row.status === 'succeeded';
            },
            () => 'delivery ' + runId + ' ' + worker.output(),
        );
        await waitUntil(
            async () =>
                (await fixture.db
                    .select({ count: count() })
                    .from(tables.outbox)
                    .where(
                        and(eq(tables.outbox.aggregateId, runId), isNotNull(tables.outbox.sentAt)),
                    )
                    .then(([row]) => row!.count)) === 1,
            () => 'outbox acknowledgement ' + runId,
        );
        const stored = await fixture.db.query.reports
            .findFirst({ where: and(eq(tables.reports.runId, runId)) })
            .then(requireRow);
        return await json<Report>('/reports/' + stored.id, owner);
    } finally {
        await worker.stop();
    }
}
const command = (body: unknown, key = randomUUID()): RequestInit => ({
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify(body),
});
type List<T> = { items: T[]; nextCursor: string | null };

describe('后端跨能力旅程：生产报告→资料库→证据问答→明确后续研究', () => {
    it('真实双账号HTTP/PG/Redis/独立Worker贯通，反馈可撤销且历史报告和版本不改', async () => {
        const owner = await fixture.register(),
            foreign = await fixture.register();
        const config = draftConfig({
            title: '英语课程资料与费用',
            topic: 'B1英语材料',
            goal: '查阅英语课程的字幕、音频和费用',
            focusPoints: [],
            exclusions: [],
            outputFormat: 'research_report',
            notificationPreference: { mode: 'summary', runIssues: true },
        });
        const detail = await json<{ task: { id: string; currentVersionId: string } }>(
            '/tasks',
            owner,
            command({ config }),
            201,
        );
        const task = detail.task;
        const queueName = 'scova-journey-' + randomUUID();
        const queue = new Queue(queueName, { connection: fixture.redis });
        try {
            const first = await json<{ run: Run }>(
                '/tasks/' + task.id + '/runs',
                owner,
                command({ mode: 'live' }),
                202,
            );
            const original = await deliver(first.run.id, 'A', queueName, owner);
            expect(original).toMatchObject({
                format: 'research_report',
                mode: 'live',
                outcome: 'baseline',
            });
            const evidence = original.evidence[0]!;
            const sourceId = evidence.sourceId;
            const originalRun = await fixture.db.query.runs
                .findFirst({ where: and(eq(tables.runs.id, original.runId)) })
                .then(requireRow);
            const originalRow = await fixture.db.query.reports
                .findFirst({ where: and(eq(tables.reports.id, original.id)) })
                .then(requireRow);
            const initialBaseline = await fixture.db.query.baselines
                .findFirst({
                    where: and(
                        eq(tables.baselines.userId, owner.id),
                        eq(tables.baselines.taskId, task.id),
                    ),
                })
                .then(requireRow);
            expect(initialBaseline.completeRunId).toBe(original.runId);

            const bookmark = await json<{
                bookmark: { id: string; sourceId: string };
                reused: boolean;
            }>('/bookmarks', owner, command({ sourceId }), 201);
            expect(bookmark).toMatchObject({ reused: false, bookmark: { sourceId } });
            const noteBody = '跨能力旅程核对：保留报告原文，继续核查课程费用与字幕条件。';
            const note = await json<{ note: { id: string; body: string }; reused: boolean }>(
                '/notes',
                owner,
                command({ target: { kind: 'source', id: sourceId }, body: noteBody }),
                201,
            );
            expect(note.note.body).toBe(noteBody);
            const query = encodeURIComponent('跨能力旅程核对');
            const search = await json<List<{ id: string; kind: string; excerpt: string }>>(
                '/library/search?kind=note&bookmarked=true&q=' + query,
                owner,
            );
            expect(search.items).toHaveLength(1);
            expect(search.items[0]).toMatchObject({ id: note.note.id, kind: 'note' });
            expect(search.items[0]!.excerpt).toContain('跨能力旅程核对');
            const snapshotPath =
                '/library/sources/' + sourceId + '/snapshots/' + evidence.snapshotId;
            const snapshot = await json<{
                snapshot: { runId: string; bodyStatus: string; mode: string };
                textBody: string | null;
                quotes: { id: string; quote: string }[];
            }>(snapshotPath, owner);
            expect(snapshot.snapshot).toMatchObject({
                runId: original.runId,
                bodyStatus: 'available',
                mode: 'live',
            });
            expect(snapshot.textBody).toContain(evidence.quote);
            expect(snapshot.quotes).toContainEqual(
                expect.objectContaining({ id: evidence.id, quote: evidence.quote }),
            );

            expect(
                (await fixture.request('/bookmarks', foreign, command({ sourceId }))).status,
            ).toBe(404);
            expect(
                (
                    await fixture.request(
                        '/notes',
                        foreign,
                        command({
                            target: { kind: 'source', id: sourceId },
                            body: '不得借用其他账号来源',
                        }),
                    )
                ).status,
            ).toBe(404);
            expect((await fixture.request('/notes/' + note.note.id, foreign)).status).toBe(404);
            expect((await fixture.request(snapshotPath, foreign)).status).toBe(404);
            expect(
                (
                    await fixture.request('/bookmarks/' + bookmark.bookmark.id, foreign, {
                        method: 'DELETE',
                    })
                ).status,
            ).toBe(404);
            for (const path of ['/bookmarks', '/notes', '/library/search?q=' + query])
                expect((await json<List<{ id: string }>>(path, foreign)).items).toEqual([]);

            const toolCount = await fixture.db
                .select({ count: count() })
                .from(tables.toolCalls)
                .where(and(eq(tables.toolCalls.userId, owner.id)))
                .then(([row]) => row!.count);
            const questionText = '请引述报告的一条原文，并深入核查后续条件。';
            const questionPath = '/reports/' + original.id + '/questions';
            const question = await json<ReportQuestion>(
                questionPath,
                owner,
                command({ question: questionText }),
                201,
            );
            expect(question).toMatchObject({
                reportId: original.id,
                followupRunId: null,
                answer: {
                    status: 'answered',
                    reason: 'evidence_answer',
                    needsResearch: true,
                    usage: { attempts: 1, inputTokens: 1, outputTokens: 1, estimated: false },
                },
            });
            const allowedIds = new Set(original.evidence.map((entry) => entry.id));
            expect(question.answer.statements).toHaveLength(1);
            expect(
                question.answer.statements.every((statement) =>
                    statement.citations.every((citation) => allowedIds.has(citation.evidenceId)),
                ),
            ).toBe(true);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.questionEvidence)
                    .where(and(eq(tables.questionEvidence.questionId, question.id)))
                    .then(([row]) => row!.count),
            ).toBeGreaterThan(0);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.runs)
                    .where(and(eq(tables.runs.userId, owner.id), eq(tables.runs.taskId, task.id)))
                    .then(([row]) => row!.count),
            ).toBe(1);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.outbox)
                    .where(and(eq(tables.outbox.userId, owner.id)))
                    .then(([row]) => row!.count),
            ).toBe(1);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.toolCalls)
                    .where(and(eq(tables.toolCalls.userId, owner.id)))
                    .then(([row]) => row!.count),
            ).toBe(toolCount);
            expect(
                (
                    await fixture.db.query.runs
                        .findFirst({ where: and(eq(tables.runs.id, original.runId)) })
                        .then(requireRow)
                ).usageJson,
            ).toEqual(originalRun.usageJson);
            const savedQuestionPath = questionPath + '/' + question.id;
            expect(await json<ReportQuestion>(savedQuestionPath, owner)).toEqual(question);
            expect(
                (await fixture.request(questionPath, foreign, command({ question: questionText })))
                    .status,
            ).toBe(404);
            expect((await fixture.request(savedQuestionPath, foreign)).status).toBe(404);
            expect(
                (
                    await fixture.request(
                        savedQuestionPath + '/followup',
                        foreign,
                        command({ confirm: true }),
                    )
                ).status,
            ).toBe(404);

            // The current feedback must also be captured by the question followup path,
            // which shares createRun with ordinary manual/retry commands.
            const feedback = await json<Feedback>(
                '/feedback',
                owner,
                command({
                    taskId: task.id,
                    sourceId,
                    kind: 'deeper',
                }),
            );
            expect(feedback).toMatchObject({
                taskId: task.id,
                sourceId,
                kind: 'deeper',
                active: true,
            });
            expect(
                (
                    await fixture.request(
                        '/feedback',
                        foreign,
                        command({
                            taskId: task.id,
                            sourceId,
                            kind: 'deeper',
                        }),
                    )
                ).status,
            ).toBe(404);

            // Asking a question and declining explicit confirmation never enqueue research.
            expect(
                (
                    await fixture.request(
                        savedQuestionPath + '/followup',
                        owner,
                        command({ confirm: false }),
                    )
                ).status,
            ).toBe(422);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.runs)
                    .where(and(eq(tables.runs.userId, owner.id)))
                    .then(([row]) => row!.count),
            ).toBe(1);
            const followup = await json<{ run: Run; reused: boolean }>(
                savedQuestionPath + '/followup',
                owner,
                command({ confirm: true }),
                202,
            );
            expect(followup.reused).toBe(false);
            const followupRow = await fixture.db.query.runs
                .findFirst({ where: and(eq(tables.runs.id, followup.run.id)) })
                .then(requireRow);
            expect(followupRow).toMatchObject({
                trigger: 'followup',
                taskVersionId: task.currentVersionId,
                mode: 'live',
                followupConfigJson: { goal: questionText, focusPoints: [], budget: config.budget },
            });
            const frozenFeedback = readFeedbackSnapshot(
                followupRow.feedbackSnapshotJson,
                owner.id,
                task.id,
            );
            expect(frozenFeedback.items).toHaveLength(1);
            expect(frozenFeedback.items[0]).toMatchObject({
                id: feedback.id,
                kind: 'deeper',
                sourceId,
            });
            expect(followupRow.comparisonScopeHash).not.toBe(originalRun.comparisonScopeHash);
            const researched = await deliver(followup.run.id, 'B', queueName, owner);
            expect(researched).toMatchObject({
                taskId: task.id,
                baselineRunId: null,
                outcome: 'baseline',
                format: 'research_report',
                mode: 'live',
            });
            const searches = await fixture.db.query.toolCalls.findMany({
                where: and(
                    eq(tables.toolCalls.runId, followup.run.id),
                    eq(tables.toolCalls.tool, 'search'),
                    eq(tables.toolCalls.status, 'succeeded'),
                ),
            });
            const executedQueries = searches
                .map(
                    (call) =>
                        (call.outputRef as { result?: { query?: string } } | null)?.result?.query,
                )
                .filter((entry): entry is string => typeof entry === 'string');
            expect(executedQueries.some((entry) => entry.includes(questionText))).toBe(true);
            const targetUrl = frozenFeedback.items[0]!.sources[0]!.url;
            expect(
                executedQueries.some(
                    (entry) => entry.includes(targetUrl) && entry.includes('详细条件'),
                ),
            ).toBe(true);
            const expanded = (researched.feedbackEffects ?? []).filter(
                (effect) => effect.feedbackId === feedback.id && effect.effect === 'expanded_query',
            );
            expect(expanded).toHaveLength(1);
            // The user-facing explanation must name an actually executed search,
            // rather than only asserting that a feedback item reached the plan.
            for (const effect of expanded) expect(executedQueries).toContain(effect.query);
            const researchedRow = await fixture.db.query.reports
                .findFirst({ where: and(eq(tables.reports.id, researched.id)) })
                .then(requireRow);
            expect((await json<ReportQuestion>(savedQuestionPath, owner)).followupRunId).toBe(
                followup.run.id,
            );
            expect(
                await fixture.db.query.baselines
                    .findFirst({ where: and(eq(tables.baselines.id, initialBaseline.id)) })
                    .then(requireRow),
            ).toEqual(initialBaseline);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.baselines)
                    .where(
                        and(
                            eq(tables.baselines.userId, owner.id),
                            eq(tables.baselines.taskId, task.id),
                        ),
                    )
                    .then(([row]) => row!.count),
            ).toBe(2);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.taskVersions)
                    .where(and(eq(tables.taskVersions.taskId, task.id)))
                    .then(([row]) => row!.count),
            ).toBe(1);
            expect(
                await fixture.db.query.reports
                    .findFirst({ where: and(eq(tables.reports.id, original.id)) })
                    .then(requireRow),
            ).toEqual(originalRow);
            expect(await json<Report>('/reports/' + original.id, owner)).toEqual(original);
            for (const path of ['/reports/' + researched.id, '/runs/' + followup.run.id])
                expect((await fixture.request(path, foreign)).status).toBe(404);
            // Revocation affects the next ordinary Run without rewriting the linked
            // followup's frozen input or its already-delivered feedback explanation.
            const revoked = await json<Feedback>('/feedback/' + feedback.id, owner, {
                method: 'DELETE',
            });
            expect(revoked.active).toBe(false);
            const activeFeedback = await json<{ items: Feedback[] }>(
                '/tasks/' + task.id + '/feedback',
                owner,
            );
            expect(activeFeedback.items).toEqual([]);
            const persistedFollowup = await fixture.db.query.runs
                .findFirst({ where: and(eq(tables.runs.id, followup.run.id)) })
                .then(requireRow);
            expect(
                readFeedbackSnapshot(persistedFollowup.feedbackSnapshotJson, owner.id, task.id),
            ).toEqual(frozenFeedback);
            const manual = await json<{ run: Run }>(
                '/tasks/' + task.id + '/runs',
                owner,
                command({ mode: 'live' }),
                202,
            );
            const manualRow = await fixture.db.query.runs
                .findFirst({ where: and(eq(tables.runs.id, manual.run.id)) })
                .then(requireRow);
            expect(
                readFeedbackSnapshot(manualRow.feedbackSnapshotJson, owner.id, task.id).items,
            ).toEqual([]);
            expect(manualRow.comparisonScopeHash).toBe(originalRun.comparisonScopeHash);
            const afterRevoke = await deliver(manual.run.id, 'B', queueName, owner);
            expect(afterRevoke).toMatchObject({
                mode: 'live',
                outcome: 'important_change',
                baselineRunId: original.runId,
            });
            expect(afterRevoke.feedbackEffects ?? []).toEqual([]);
            const manualSearches = await fixture.db.query.toolCalls.findMany({
                where: and(
                    eq(tables.toolCalls.runId, manual.run.id),
                    eq(tables.toolCalls.tool, 'search'),
                    eq(tables.toolCalls.status, 'succeeded'),
                ),
            });
            expect(manualSearches).toHaveLength(1);
            expect(
                manualSearches.every(
                    (call) =>
                        !(
                            call.outputRef as { result?: { query?: string } } | null
                        )?.result?.query?.includes('详细条件'),
                ),
            ).toBe(true);
            expect(
                (
                    await fixture.db.query.baselines
                        .findFirst({ where: and(eq(tables.baselines.id, initialBaseline.id)) })
                        .then(requireRow)
                ).completeRunId,
            ).toBe(manual.run.id);
            const followupBaseline = await fixture.db.query.baselines
                .findFirst({
                    where: and(
                        eq(tables.baselines.userId, owner.id),
                        eq(tables.baselines.taskId, task.id),
                        eq(tables.baselines.comparisonScopeHash, followupRow.comparisonScopeHash),
                    ),
                })
                .then(requireRow);
            expect(followupBaseline.completeRunId).toBe(followup.run.id);
            expect(
                await fixture.db.query.reports
                    .findFirst({ where: and(eq(tables.reports.id, researched.id)) })
                    .then(requireRow),
            ).toEqual(researchedRow);
            expect(await json<Report>('/reports/' + researched.id, owner)).toEqual(researched);
            expect(
                await fixture.db.query.reports
                    .findFirst({ where: and(eq(tables.reports.id, original.id)) })
                    .then(requireRow),
            ).toEqual(originalRow);
            expect(await json<Report>('/reports/' + original.id, owner)).toEqual(original);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.taskVersions)
                    .where(and(eq(tables.taskVersions.taskId, task.id)))
                    .then(([row]) => row!.count),
            ).toBe(1);
            expect(
                (
                    await fixture.db.query.taskVersions
                        .findFirst({
                            where: and(eq(tables.taskVersions.id, task.currentVersionId)),
                        })
                        .then(requireRow)
                ).configJson,
            ).toEqual(config);
            expect((await fixture.request('/reports/' + afterRevoke.id, foreign)).status).toBe(404);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.reports)
                    .where(and(eq(tables.reports.userId, owner.id)))
                    .then(([row]) => row!.count),
            ).toBe(3);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.inboxItems)
                    .where(and(eq(tables.inboxItems.userId, owner.id)))
                    .then(([row]) => row!.count),
            ).toBe(3);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.notifications)
                    .where(and(eq(tables.notifications.userId, owner.id)))
                    .then(([row]) => row!.count),
            ).toBe(3);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.notes)
                    .where(and(eq(tables.notes.userId, foreign.id)))
                    .then(([row]) => row!.count),
            ).toBe(0);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.bookmarks)
                    .where(and(eq(tables.bookmarks.userId, foreign.id)))
                    .then(([row]) => row!.count),
            ).toBe(0);
            expect(
                await fixture.db
                    .select({ count: count() })
                    .from(tables.reportQuestions)
                    .where(and(eq(tables.reportQuestions.userId, foreign.id)))
                    .then(([row]) => row!.count),
            ).toBe(0);
            console.log(
                JSON.stringify({
                    journey: 'report-library-question-feedback-followup-revocation',
                    boundary:
                        'fixed supplier replies; real authenticated HTTP/PG/Redis/independent worker/checkpoint/delivery',
                    originalRunId: original.runId,
                    followupRunId: followup.run.id,
                    afterRevokeRunId: manual.run.id,
                    feedbackId: feedback.id,
                    questionId: question.id,
                    noteId: note.note.id,
                    baselineScopes: 2,
                }),
            );
        } finally {
            await queue.obliterate({ force: true });
            await queue.close();
        }
    }, 180_000);
});
