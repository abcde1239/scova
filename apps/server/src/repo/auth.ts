import { and, eq, isNull, isUniqueConflict, type DatabaseExecutor, type User } from '@scova/db';
import * as tables from '@scova/db';
import type { ApiServices } from '@/app/context.ts';
import { firstRow } from '@/utils/database.ts';

function sessionStore(database: DatabaseExecutor) {
    return {
        createUser: (data: typeof tables.users.$inferInsert) =>
            database.insert(tables.users).values(data).returning().then(firstRow),
        revokePrevious: (hash: string, now: Date) =>
            database
                .update(tables.sessions)
                .set({ revokedAt: now })
                .where(and(eq(tables.sessions.tokenHash, hash), isNull(tables.sessions.revokedAt)))
                .returning()
                .then((rows) => ({ count: rows.length })),
        createSession: (data: typeof tables.sessions.$inferInsert) =>
            database.insert(tables.sessions).values(data).returning().then(firstRow),
    };
}

export type AuthTransaction = ReturnType<typeof sessionStore>;
const rateScript = `local a=redis.call('INCR',KEYS[1]); if a==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local b=redis.call('INCR',KEYS[2]); if b==1 then redis.call('EXPIRE',KEYS[2],ARGV[1]) end; return {a,b}`;

/** 认证持久化适配；事务回调中的操作共享同一个数据库连接。 */
export function createAuthRepository(services: ApiServices) {
    return {
        isUniqueConflict,
        transaction: <T>(operation: (store: AuthTransaction) => Promise<T>) =>
            services.db().transaction((database) => operation(sessionStore(database))),
        findSession: (hash: string) =>
            services
                .db()
                .query.sessions.findFirst({
                    where: and(eq(tables.sessions.tokenHash, hash)),
                    with: { owner: true },
                })
                .then((row) => row ?? null),
        findUser: (normalizedEmail: string) =>
            services
                .db()
                .query.users.findFirst({
                    where: and(eq(tables.users.normalizedEmail, normalizedEmail)),
                })
                .then((row) => row ?? null),
        revokeSession: (id: string, now: Date) =>
            services
                .db()
                .update(tables.sessions)
                .set({ revokedAt: now })
                .where(and(eq(tables.sessions.id, id)))
                .returning()
                .then(firstRow),
        updatePreferences: (
            userId: string,
            data: Pick<
                Partial<typeof tables.users.$inferInsert>,
                'defaultTimezone' | 'notificationPreference'
            >,
        ): Promise<User> =>
            services
                .db()
                .update(tables.users)
                .set(data)
                .where(and(eq(tables.users.id, userId)))
                .returning()
                .then(firstRow),
        findOwnedTask: (id: string, userId: string) =>
            services
                .db()
                .query.tasks.findFirst({
                    where: and(eq(tables.tasks.id, id), eq(tables.tasks.userId, userId)),
                })
                .then((row) => row ?? null),
        async countAttempts(globalKey: string, accountKey: string, windowSeconds: number) {
            const redis = services.redis();
            if (redis.status === 'wait') await redis.connect();
            return redis.eval(rateScript, 2, globalKey, accountKey, windowSeconds);
        },
    };
}
