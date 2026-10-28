import { and, eq, inArray, isNotNull, count } from '@scova/db';
import * as tables from '@scova/db';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { Report, Run, TaskConfig } from '@scova/models';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
    scenarioData,
    scenarioNames,
    type ScenarioName,
    type ScenarioPhase,
} from '../../worker/tests/support/acceptance-scenario-fixtures.ts';
import { historyFixture, type HistoryOwner } from './support/history-fixture.ts';
import { draftConfig } from './support/task-drafts.ts';
import { startAcceptanceWorker } from './support/acceptance-worker.ts';
import { requireRow } from '../src/utils/database.ts';

const fixture = historyFixture();
const redisUrl =
    process.env.SCOVA_TEST_REDIS_URL ?? process.env.RUNTIME_REDIS_URL ?? 'redis://127.0.0.1:56379';
beforeAll(() => fixture.setup(), 120_000);
afterAll(() => fixture.cleanup());

async function waitUntil(
    check: () => Promise<boolean>,
    description: () => string,
    timeout = 30_000,
) {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
        if (Date.now() >= deadline) throw new Error('Acceptance timeout: ' + description());
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
async function json<T>(path: string, owner: HistoryOwner, init?: RequestInit): Promise<T> {
    const response = await fixture.request(path, owner, init);
    if (!response.ok)
        throw new Error(path + ': HTTP ' + response.status + ' ' + (await response.text()));
    return (await response.json()) as T;
}
type Item = {
    id: string;
    reportId?: string;
    runId?: string;
    kind?: string;
    readAt?: string | null;
};
async function list(path: string, owner: HistoryOwner) {
    return (await json<{ items: Item[]; nextCursor: string | null }>(path, owner)).items;
}
async function startWorker(name: ScenarioName, phase: ScenarioPhase, queueName: string) {
    return startAcceptanceWorker({
        databaseUrl: fixture.databaseUrl,
        redisUrl,
        name,
        phase,
        queueName,
    });
}
function scenarioConfig(name: ScenarioName): TaskConfig {
    const data = scenarioData(name, 'A');
    return draftConfig({
        title: {
            english: '英语材料连续查阅',
            admissions: '招生公告连续查阅',
            research: '研究原文连续查阅',
        }[name],
        topic: name,
        outputFormat: ({ english: 'brief', admissions: 'comparison', research: 'list' } as const)[
            name
        ],
        goal: {
            english: 'Track B1 audio, subtitles and fees',
            admissions: 'Track programme requirements, deadlines and scholarships',
            research: 'Track original findings and sample counts',
        }[name],
        focusPoints: [],
        exclusions: [],
        sourcePreferences: {
            preferredUrls: name === 'admissions' ? [data.changedUrl] : [],
            excludedUrls: [],
            // Domain/URL preference does not certify official identity.
            officialOnly: false,
        },
        notificationPreference: { mode: 'summary', runIssues: true },
    });
}
async function createRun(taskId: string, owner: HistoryOwner, key: string) {
    const response = await fixture.request('/tasks/' + taskId + '/runs', owner, {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: JSON.stringify({ mode: 'live' }),
    });
    expect(response.status).toBe(202);
    return (await response.json()) as { run: Run; reused: boolean };
}
async function counts(ownerId: string, taskId: string) {
    return {
        runs: await fixture.db
            .select({ count: count() })
            .from(tables.runs)
            .where(and(eq(tables.runs.userId, ownerId), eq(tables.runs.taskId, taskId)))
            .then(([row]) => row!.count),
        reports: await fixture.db
            .select({ count: count() })
            .from(tables.reports)
            .where(and(eq(tables.reports.userId, ownerId), eq(tables.reports.taskId, taskId)))
            .then(([row]) => row!.count),
        inbox: await fixture.db
            .select({ count: count() })
            .from(tables.inboxItems)
            .where(and(eq(tables.inboxItems.userId, ownerId)))
            .then(([row]) => row!.count),
        notifications: await fixture.db
            .select({ count: count() })
            .from(tables.notifications)
            .where(and(eq(tables.notifications.userId, ownerId)))
            .then(([row]) => row!.count),
        baseline: await fixture.db
            .select({ count: count() })
            .from(tables.baselines)
            .where(and(eq(tables.baselines.userId, ownerId), eq(tables.baselines.taskId, taskId)))
            .then(([row]) => row!.count),
    };
}

describe('三类公开示例：真实认证HTTP→Outbox/BullMQ→独立生产Worker→交付API', () => {
    it.each(scenarioNames)(
        '%s：两轮完整比较、幂等投递和第三轮partial保留基线',
        async (name) => {
            const owner = await fixture.register();
            const foreign = await fixture.register();
            const detail = await json<{ task: { id: string; currentVersionId: string } }>(
                '/tasks',
                owner,
                {
                    method: 'POST',
                    body: JSON.stringify({ config: scenarioConfig(name) }),
                },
            );
            const task = detail.task;
            const queueName = 'scova-acceptance-' + randomUUID();
            const queue = new Queue(queueName, { connection: fixture.redis });
            const reports: Report[] = [];
            const runIds: string[] = [];
            try {
                for (const [index, phase] of (['A', 'B', 'C'] as const).entries()) {
                    const worker = await startWorker(name, phase, queueName);
                    try {
                        const key = 'acceptance-' + name + '-' + phase + '-' + randomUUID();
                        const created = await createRun(task.id, owner, key);
                        expect(created.reused).toBe(false);
                        const runId = created.run.id;
                        runIds.push(runId);
                        await waitUntil(
                            async () => {
                                const run = await fixture.db.query.runs
                                    .findFirst({ where: and(eq(tables.runs.id, runId)) })
                                    .then(requireRow);
                                if (run.status === 'failed' || run.status === 'canceled')
                                    throw new Error(
                                        'Production Run failed: ' +
                                            run.failureCode +
                                            ' ' +
                                            worker.output(),
                                    );
                                return run.status === 'partial' || run.status === 'succeeded';
                            },
                            () => name + '/' + phase + ' delivery; ' + worker.output(),
                        );
                        await waitUntil(
                            async () =>
                                (await fixture.db
                                    .select({ count: count() })
                                    .from(tables.outbox)
                                    .where(
                                        and(
                                            eq(tables.outbox.aggregateId, runId),
                                            isNotNull(tables.outbox.sentAt),
                                        ),
                                    )
                                    .then(([row]) => row!.count)) === 1,
                            () => name + '/' + phase + ' production outbox ACK',
                        );
                        const run = await json<Run>('/runs/' + runId, owner);
                        expect(run).toMatchObject({
                            id: runId,
                            taskId: task.id,
                            taskVersionId: task.currentVersionId,
                            mode: 'live',
                            status: phase === 'C' ? 'partial' : 'succeeded',
                            coverage: { completeness: phase === 'C' ? 'partial' : 'complete' },
                        });
                        expect(run).not.toHaveProperty('checkpointRef');
                        expect(run).not.toHaveProperty('leaseOwner');
                        const stored = await fixture.db.query.runs
                            .findFirst({ where: and(eq(tables.runs.id, runId)) })
                            .then(requireRow);
                        expect(stored.leaseEpoch).toBeGreaterThan(0);
                        expect(stored.checkpointRef).not.toBeNull();
                        expect(
                            await fixture.db
                                .select({ count: count() })
                                .from(tables.toolCalls)
                                .where(
                                    and(
                                        eq(tables.toolCalls.runId, runId),
                                        eq(tables.toolCalls.status, 'succeeded'),
                                        eq(tables.toolCalls.tool, 'model'),
                                    ),
                                )
                                .then(([row]) => row!.count),
                        ).toBeGreaterThan(0);
                        expect(
                            await fixture.db
                                .select({ count: count() })
                                .from(tables.toolCalls)
                                .where(
                                    and(
                                        eq(tables.toolCalls.runId, runId),
                                        eq(tables.toolCalls.status, 'succeeded'),
                                        eq(tables.toolCalls.tool, 'read'),
                                    ),
                                )
                                .then(([row]) => row!.count),
                        ).toBeGreaterThan(0);

                        const row = await fixture.db.query.reports
                            .findFirst({ where: and(eq(tables.reports.runId, runId)) })
                            .then(requireRow);
                        const report = await json<Report>('/reports/' + row.id, owner);
                        reports.push(report);
                        expect(report.format).toBe(scenarioConfig(name).outputFormat);
                        expect(report).toMatchObject({
                            runId,
                            taskId: task.id,
                            mode: 'live',
                            baselineRunId: index === 0 ? null : runIds[index - 1],
                            outcome:
                                phase === 'A'
                                    ? 'baseline'
                                    : phase === 'B'
                                      ? 'important_change'
                                      : 'inconclusive',
                        });
                        expect(
                            report.claims.some(
                                (claim) => claim.kind === 'fact' && claim.evidenceIds.length > 0,
                            ),
                        ).toBe(true);
                        expect(
                            report.evidence.every(
                                (evidence) => evidence.snapshot?.contentHash && evidence.quote,
                            ),
                        ).toBe(true);
                        if (phase === 'B') {
                            expect(
                                report.changes.filter((change) => change.kind === 'duplicate'),
                            ).toHaveLength(1);
                            const changed = report.changes.filter(
                                (change) => change.kind === 'changed',
                            );
                            expect(changed).toHaveLength(scenarioData(name, phase).changed.length);
                            expect(
                                report.changes.filter((change) => change.kind === 'new'),
                            ).toHaveLength(1);
                            for (const change of changed) {
                                expect(change.oldEvidenceIds.length).toBeGreaterThan(0);
                                expect(change.newEvidenceIds.length).toBeGreaterThan(0);
                                expect(change.oldValue).not.toBe(change.newValue);
                                const oldEvidence = await fixture.db.query.evidence.findMany({
                                    where: and(inArray(tables.evidence.id, change.oldEvidenceIds)),
                                });
                                const newEvidence = await fixture.db.query.evidence.findMany({
                                    where: and(inArray(tables.evidence.id, change.newEvidenceIds)),
                                });
                                expect(
                                    oldEvidence.every(
                                        (evidence) =>
                                            evidence.runId === runIds[0] &&
                                            evidence.userId === owner.id,
                                    ),
                                ).toBe(true);
                                expect(
                                    newEvidence.every(
                                        (evidence) =>
                                            evidence.runId === runId &&
                                            evidence.userId === owner.id,
                                    ),
                                ).toBe(true);
                            }
                        }
                        if (phase === 'C') {
                            expect(report.coverage.gaps.length).toBeGreaterThan(0);
                            expect(report.limitations.length).toBeGreaterThan(0);
                            expect(report.outcome).not.toBe('no_important_change');
                            expect(
                                await fixture.db
                                    .select({ count: count() })
                                    .from(tables.toolCalls)
                                    .where(
                                        and(
                                            eq(tables.toolCalls.runId, runId),
                                            eq(tables.toolCalls.tool, 'read'),
                                            eq(tables.toolCalls.status, 'unknown'),
                                        ),
                                    )
                                    .then(([row]) => row!.count),
                            ).toBe(1);
                        }
                        const baseline = await fixture.db.query.baselines
                            .findFirst({
                                where: and(
                                    eq(tables.baselines.userId, owner.id),
                                    eq(tables.baselines.taskId, task.id),
                                ),
                            })
                            .then(requireRow);
                        expect(baseline.completeRunId).toBe(phase === 'C' ? runIds[1] : runId);
                        expect(await counts(owner.id, task.id)).toEqual({
                            runs: index + 1,
                            reports: index + 1,
                            inbox: index + 1,
                            notifications: index + 1,
                            baseline: 1,
                        });
                        expect(await list('/reports?taskId=' + task.id, owner)).toHaveLength(
                            index + 1,
                        );
                        const inbox = await list('/inbox', owner);
                        expect(
                            inbox
                                .map((item) => item.reportId!)
                                .sort((left, right) => left.localeCompare(right)),
                        ).toEqual(
                            reports
                                .map((item) => item.id)
                                .sort((left, right) => left.localeCompare(right)),
                        );
                        const notifications = await list('/notifications', owner);
                        expect(notifications).toHaveLength(index + 1);
                        const notification = notifications.find((item) => item.runId === runId)!;
                        expect(notification).toMatchObject({
                            reportId: report.id,
                            kind: phase === 'C' ? 'run_issue' : 'summary',
                            readAt: null,
                        });
                        expect(
                            await fixture.db
                                .select({ count: count() })
                                .from(tables.reports)
                                .where(and(eq(tables.reports.runId, runId)))
                                .then(([row]) => row!.count),
                        ).toBe(1);
                        expect(
                            await fixture.db
                                .select({ count: count() })
                                .from(tables.inboxItems)
                                .where(and(eq(tables.inboxItems.reportId, report.id)))
                                .then(([row]) => row!.count),
                        ).toBe(1);
                        expect(
                            await fixture.db
                                .select({ count: count() })
                                .from(tables.notifications)
                                .where(and(eq(tables.notifications.runId, runId)))
                                .then(([row]) => row!.count),
                        ).toBe(1);

                        for (const path of [
                            '/runs/' + runId,
                            '/runs/' + runId + '/events',
                            '/reports/' + report.id,
                        ])
                            expect((await fixture.request(path, foreign)).status).toBe(404);
                        expect(
                            (
                                await fixture.request('/inbox/' + inbox[0]!.id, foreign, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ read: true }),
                                })
                            ).status,
                        ).toBe(404);
                        expect(
                            (
                                await fixture.request(
                                    '/notifications/' + notification.id,
                                    foreign,
                                    {
                                        method: 'PATCH',
                                        body: JSON.stringify({ read: true }),
                                    },
                                )
                            ).status,
                        ).toBe(404);
                        expect(await list('/reports', foreign)).toHaveLength(0);
                        expect(await list('/inbox', foreign)).toHaveLength(0);
                        expect(await list('/notifications', foreign)).toHaveLength(0);

                        if (phase === 'B') {
                            const before = await counts(owner.id, task.id);
                            const repeated = await createRun(task.id, owner, key);
                            expect(repeated).toMatchObject({ reused: true, run: { id: runId } });
                            const replay = await queue.add(
                                'run.enqueue',
                                { runId },
                                { jobId: 'terminal-replay-' + runId },
                            );
                            await waitUntil(
                                async () => (await replay.getState()) === 'completed',
                                () => 'terminal Run replay; ' + worker.output(),
                            );
                            expect(await counts(owner.id, task.id)).toEqual(before);
                            expect(
                                (
                                    await fixture.db.query.baselines
                                        .findFirst({
                                            where: and(eq(tables.baselines.id, baseline.id)),
                                        })
                                        .then(requireRow)
                                ).completeRunId,
                            ).toBe(runId);
                        }
                        console.log(
                            JSON.stringify({
                                scenario: name,
                                phase,
                                boundary:
                                    'fixed live suppliers; real HTTP/PG/Redis/worker/checkpoint/delivery',
                                runId,
                                reportId: report.id,
                                outcome: report.outcome,
                                changes: report.changes.map((change) => change.kind),
                                notifications: notification.kind,
                                baselineRunId: baseline.completeRunId,
                            }),
                        );
                    } finally {
                        await worker.stop();
                    }
                }
            } finally {
                await queue.obliterate({ force: true });
                await queue.close();
            }
        },
        180_000,
    );
});
