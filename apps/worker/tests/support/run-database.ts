import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@scova/db';
import type { TaskConfig } from '@scova/models';

export const runConfig = (): TaskConfig => ({
    title: '生命周期测试',
    topic: '公开信息研究',
    goal: '查找可追溯资料',
    focusPoints: ['来源'],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'UTC',
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40_000,
        maxOutputTokens: 8_000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
});
export const emptyUsage = () => ({
    searches: 0,
    pages: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: true,
});

/** Each scenario owns an independent user/task/run; never flush the shared Redis. */
export async function seedRun(db: PrismaClient, options: { mode?: 'live' | 'demo' } = {}) {
    const config = runConfig();
    const email = `${randomUUID()}@example.test`;
    const user = await db.user.create({
        data: { email, normalizedEmail: email, passwordHash: 'test' },
    });
    const task = await db.task.create({ data: { userId: user.id, title: config.title } });
    const version = await db.taskVersion.create({
        data: {
            userId: user.id,
            taskId: task.id,
            version: 1,
            comparisonScopeHash: 'a'.repeat(64),
            configJson: config,
        },
    });
    await db.task.update({ where: { id: task.id }, data: { currentVersionId: version.id } });
    const run = await db.run.create({
        data: {
            userId: user.id,
            taskId: task.id,
            taskVersionId: version.id,
            mode: options.mode ?? 'demo',
            trigger: 'manual',
            comparisonScopeHash: 'a'.repeat(64),
            budgetJson: config.budget,
            usageJson: emptyUsage(),
        },
    });
    await db.runEvent.create({
        data: {
            userId: user.id,
            runId: run.id,
            seq: 1,
            type: 'run.queued',
            payload: { status: 'queued', taskVersionId: version.id },
        },
    });
    const outbox = await db.outbox.create({
        data: {
            userId: user.id,
            aggregateId: run.id,
            eventType: 'run.enqueue',
            dedupeKey: `run-${run.id}-enqueue`,
            payload: { runId: run.id },
            availableAt: new Date(),
        },
    });
    return { user, task, version, run, outbox, config };
}
