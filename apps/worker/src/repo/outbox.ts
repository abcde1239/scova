import type { PrismaClient } from '@scova/models';
import type { ClaimedOutbox } from '@/utils/outbox.ts';

export interface OutboxRepository {
    claim(now: Date, leaseExpiresAt: Date): Promise<ClaimedOutbox | null>;
    ack(item: ClaimedOutbox, now: Date): Promise<boolean>;
    retry(item: ClaimedOutbox, now: Date, availableAt: Date): Promise<boolean>;
}

/** Prisma 访问集中在此；网络发布不进入数据库事务。 */
export function createOutboxRepository(db: Pick<PrismaClient, 'outbox'>): OutboxRepository {
    return {
        async claim(now, leaseExpiresAt) {
            const eligible = {
                sentAt: null,
                availableAt: { lte: now },
                OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
            };
            const candidate = await db.outbox.findFirst({
                where: eligible,
                orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
            });
            if (!candidate) return null;
            const updated = await db.outbox.updateMany({
                where: {
                    ...eligible,
                    id: candidate.id,
                    attempts: candidate.attempts,
                    leaseExpiresAt: candidate.leaseExpiresAt,
                },
                data: { leaseExpiresAt, attempts: { increment: 1 } },
            });
            if (updated.count !== 1) return null;
            return { ...candidate, leaseExpiresAt, attempts: candidate.attempts + 1 };
        },
        async ack(item, now) {
            const updated = await db.outbox.updateMany({
                where: {
                    id: item.id,
                    sentAt: null,
                    attempts: item.attempts,
                    leaseExpiresAt: { equals: item.leaseExpiresAt, gt: now },
                },
                data: { sentAt: now, leaseExpiresAt: null },
            });
            return updated.count === 1;
        },
        async retry(item, now, availableAt) {
            const updated = await db.outbox.updateMany({
                where: {
                    id: item.id,
                    sentAt: null,
                    attempts: item.attempts,
                    leaseExpiresAt: { equals: item.leaseExpiresAt, gt: now },
                },
                data: { leaseExpiresAt: null, availableAt },
            });
            return updated.count === 1;
        },
    };
}
