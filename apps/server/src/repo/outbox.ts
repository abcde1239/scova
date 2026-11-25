import { and, asc, eq, gt, isNull, lte, ne, or, outbox, sql, type DatabaseClient } from '@scova/db';
import type { ClaimedOutbox } from '../utils/outbox.ts';

export interface OutboxRepository {
    claim(now: Date, leaseExpiresAt: Date): Promise<ClaimedOutbox | null>;
    ack(item: ClaimedOutbox, now: Date): Promise<boolean>;
    retry(item: ClaimedOutbox, now: Date, availableAt: Date): Promise<boolean>;
}

/** Native database operations stay here; network publication never enters a transaction. */
export function createOutboxRepository(
    db: DatabaseClient,
    { excludeEventType }: { excludeEventType?: string } = {},
): OutboxRepository {
    return {
        async claim(now, leaseExpiresAt) {
            const eligible = and(
                excludeEventType === undefined ? undefined : ne(outbox.eventType, excludeEventType),
                isNull(outbox.sentAt),
                lte(outbox.availableAt, now),
                or(isNull(outbox.leaseExpiresAt), lte(outbox.leaseExpiresAt, now)),
            );
            // Select and take the lease in one statement. A concurrent dispatcher can skip
            // the row locked by another claim and continue with the next available job.
            const candidate = db
                .select({ id: outbox.id })
                .from(outbox)
                .where(eligible)
                .orderBy(asc(outbox.availableAt), asc(outbox.id))
                .limit(1)
                .for('update', { skipLocked: true });
            const [claimed] = await db
                .update(outbox)
                .set({ leaseExpiresAt, attempts: sql`${outbox.attempts} + 1` })
                .where(eq(outbox.id, sql`(${candidate})`))
                .returning();
            return claimed ? { ...claimed, leaseExpiresAt } : null;
        },
        async ack(item, now) {
            const updated = await db
                .update(outbox)
                .set({ sentAt: now, leaseExpiresAt: null })
                .where(
                    and(
                        eq(outbox.id, item.id),
                        isNull(outbox.sentAt),
                        eq(outbox.attempts, item.attempts),
                        eq(outbox.leaseExpiresAt, item.leaseExpiresAt),
                        gt(outbox.leaseExpiresAt, now),
                    ),
                )
                .returning({ id: outbox.id });
            return updated.length === 1;
        },
        async retry(item, now, availableAt) {
            const updated = await db
                .update(outbox)
                .set({ leaseExpiresAt: null, availableAt })
                .where(
                    and(
                        eq(outbox.id, item.id),
                        isNull(outbox.sentAt),
                        eq(outbox.attempts, item.attempts),
                        eq(outbox.leaseExpiresAt, item.leaseExpiresAt),
                        gt(outbox.leaseExpiresAt, now),
                    ),
                )
                .returning({ id: outbox.id });
            return updated.length === 1;
        },
    };
}
