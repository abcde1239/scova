import { createHash } from 'node:crypto';
import {
    and,
    eq,
    gt,
    gte,
    idempotencyRecords,
    isNotNull,
    sql,
    tasks,
    runs,
    users,
    type DatabaseTransaction,
} from '@scova/db';
import { DEFAULT_TASK_BUDGET_LIMITS, type Budget, type ProjectAutonomyInput } from '@scova/models';

const scope = 'project-agent:auto-run-budget';
type Admission = { userId: string; budget: Budget; now: Date; dailyLimit: number };

export async function projectRunAllowance(
    tx: DatabaseTransaction,
    { userId, budget, now, dailyLimit }: Admission,
): Promise<ProjectAutonomyInput['budget']> {
    if (
        Object.entries(DEFAULT_TASK_BUDGET_LIMITS).some(
            ([key, limit]) => budget[key as keyof Budget]! > limit,
        )
    )
        return 'exceeded';
    if (!dailyLimit) return 'unavailable';
    // Serialize automatic admissions across projects for the duration of the write transaction.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update');
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const count = { value: sql<number>`count(*)::int` };
    const [[oneShots], [recurrences], [alreadyScheduled]] = await Promise.all([
        tx
            .select(count)
            .from(idempotencyRecords)
            .where(
                and(
                    eq(idempotencyRecords.userId, userId),
                    eq(idempotencyRecords.scope, scope),
                    gt(idempotencyRecords.expiresAt, now),
                ),
            ),
        tx
            .select(count)
            .from(tasks)
            .where(
                and(
                    eq(tasks.userId, userId),
                    eq(tasks.status, 'active'),
                    isNotNull(tasks.nextRunAt),
                ),
            ),
        tx
            .select(count)
            .from(runs)
            .where(
                and(
                    eq(runs.userId, userId),
                    eq(runs.trigger, 'scheduled'),
                    gte(runs.queuedAt, midnight),
                ),
            ),
    ]);
    // Conservatively keep room for active schedules and those already executed this day.
    const usage =
        (oneShots?.value ?? 0) + (recurrences?.value ?? 0) + (alreadyScheduled?.value ?? 0);
    return usage < dailyLimit ? 'authorized' : 'exceeded';
}

export async function reserveProjectAutoRun(
    tx: DatabaseTransaction,
    input: Admission & { turnId: string },
) {
    const allowance = await projectRunAllowance(tx, input);
    if (allowance !== 'authorized') return allowance;
    const { userId, turnId, budget, now } = input;
    const expiresAt = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    // Charge the day even if the user later deletes the conversation or the Run.
    await tx.insert(idempotencyRecords).values({
        userId,
        scope,
        expiresAt,
        status: 'completed',
        keyHash: hash(turnId),
        payloadHash: hash(JSON.stringify(budget)),
        resourceId: turnId,
    });
    return allowance;
}
