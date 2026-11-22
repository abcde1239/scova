import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import {
    type DatabaseClient,
    users as dbUsers,
    tasks as dbTasks,
    taskVersions as dbTaskVersions,
    eq,
    runs as dbRuns,
    runEvents as dbRunEvents,
    outbox as dbOutbox,
} from '@scova/db';
import { randomUUID } from 'node:crypto';

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
export async function seedRun(
    db: DatabaseClient,
    options: { mode?: 'live' | 'demo'; maxInputTokens?: number } = {},
) {
    const config = runConfig();
    if (options.maxInputTokens !== undefined) config.budget.maxInputTokens = options.maxInputTokens;
    const email = `${randomUUID()}@example.test`;
    const user = await db
        .insert(dbUsers)
        .values({ email: email, normalizedEmail: email, passwordHash: 'test' })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    const task = await db
        .insert(dbTasks)
        .values({ userId: user.id, title: config.title })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    const version = await db
        .insert(dbTaskVersions)
        .values({
            userId: user.id,
            taskId: task.id,
            version: 1,
            comparisonScopeHash: 'a'.repeat(64),
            configJson: config,
        })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    await db
        .update(dbTasks)
        .set({ currentVersionId: version.id })
        .where(eq(dbTasks.id, task.id))
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    const run = await db
        .insert(dbRuns)
        .values({
            userId: user.id,
            taskId: task.id,
            taskVersionId: version.id,
            mode: options.mode ?? 'demo',
            trigger: 'manual',
            comparisonScopeHash: 'a'.repeat(64),
            budgetJson: config.budget,
            usageJson: emptyUsage(),
        })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    await db
        .insert(dbRunEvents)
        .values({
            userId: user.id,
            runId: run.id,
            seq: 1,
            type: 'run.queued',
            payload: { status: 'queued', taskVersionId: version.id },
        })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    const outbox = await db
        .insert(dbOutbox)
        .values({
            userId: user.id,
            aggregateId: run.id,
            eventType: 'run.enqueue',
            dedupeKey: `run-${run.id}-enqueue`,
            payload: { runId: run.id },
            availableAt: new Date(),
        })
        .returning()
        .then((rows) => requiredDatabaseValue(rows[0]));
    return { user, task, version, run, outbox, config };
}
