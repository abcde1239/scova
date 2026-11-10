import { and, eq, isNull, users } from '@scova/db';
import type { ApiServices } from '@/app/services';

export function createAvatarRepository(services: ApiServices) {
    return {
        async takeWriteSlot(userId: string) {
            const redis = services.redis();
            if (redis.status === 'wait') await redis.connect();
            const window = Math.floor(services.clock().getTime() / 60_000);
            const prefix = `${services.rateLimit.keyPrefix}avatar:${window}:`;
            return redis.eval(
                "local a=redis.call('INCR',KEYS[1]); if a==1 then redis.call('EXPIRE',KEYS[1],60) end; local b=redis.call('INCR',KEYS[2]); if b==1 then redis.call('EXPIRE',KEYS[2],60) end; return {a,b}",
                2,
                `${prefix}${userId}`,
                `${prefix}global`,
            );
        },
        async replace(userId: string, expectedVersion: string | null, nextVersion: string | null) {
            const rows = await services
                .db()
                .update(users)
                .set({ avatarVersion: nextVersion })
                .where(
                    and(
                        eq(users.id, userId),
                        expectedVersion === null
                            ? isNull(users.avatarVersion)
                            : eq(users.avatarVersion, expectedVersion),
                    ),
                )
                .returning();
            return rows[0] ?? null;
        },
    };
}
