import { and, asc, eq, gt, isNull, lte, or, outbox, sql, type DatabaseClient } from '@scova/db';
import type { ClaimedOutbox } from '../utils/outbox.ts';

export interface OutboxRepository {
    claim(now: Date, leaseExpiresAt: Date): Promise<ClaimedOutbox | null>;
    ack(item: ClaimedOutbox, now: Date): Promise<boolean>;
    retry(item: ClaimedOutbox, now: Date, availableAt: Date): Promise<boolean>;
}

/** Native database operations stay here; network publication never enters a transaction. */
export function createOutboxRepository(db: DatabaseClient): OutboxRepository {
    return {
        async claim(now, leaseExpiresAt) {
            const eligible = and(
                isNull(outbox.sentAt),
                lte(outbox.availableAt, now),
                or(isNull(outbox.leaseExpiresAt), lte(outbox.leaseExpiresAt, now)),
            );
            const candidate = await db.query.outbox.findFirst({
                where: eligible,
                orderBy: [asc(outbox.availableAt), asc(outbox.id)],
            });
            if (!candidate) return null;
            const updated = await db
                .update(outbox)
                .set({ leaseExpiresAt, attempts: sql`${outbox.attempts} + 1` })
                .where(
                    and(
                        eligible,
                        eq(outbox.id, candidate.id),
                        eq(outbox.attempts, candidate.attempts),
                        candidate.leaseExpiresAt === null
                            ? isNull(outbox.leaseExpiresAt)
                            : eq(outbox.leaseExpiresAt, candidate.leaseExpiresAt),
                    ),
                )
                .returning({ id: outbox.id });
            if (updated.length !== 1) return null;
            return { ...candidate, leaseExpiresAt, attempts: candidate.attempts + 1 };
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
