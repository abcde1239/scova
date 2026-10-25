import type { Prisma, User } from "@scova/models";
import type { ApiServices } from "@/app/context.ts";

function sessionStore(database: Prisma.TransactionClient) {
  return {
    createUser: (data: Prisma.UserCreateInput) => database.user.create({ data }),
    revokePrevious: (hash: string, now: Date) =>
      database.session.updateMany({
        where: { tokenHash: hash, revokedAt: null },
        data: { revokedAt: now },
      }),
    createSession: (data: Prisma.SessionUncheckedCreateInput) => database.session.create({ data }),
  };
}

export type AuthTransaction = ReturnType<typeof sessionStore>;
const rateScript = `local a=redis.call('INCR',KEYS[1]); if a==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local b=redis.call('INCR',KEYS[2]); if b==1 then redis.call('EXPIRE',KEYS[2],ARGV[1]) end; return {a,b}`;

/** 认证持久化适配；事务回调中的操作共享同一个数据库连接。 */
export function createAuthRepository(services: ApiServices) {
  return {
    transaction: <T>(operation: (store: AuthTransaction) => Promise<T>) =>
      services.db().$transaction((database) => operation(sessionStore(database))),
    findSession: (hash: string) =>
      services.db().session.findUnique({ where: { tokenHash: hash }, include: { owner: true } }),
    findUser: (normalizedEmail: string) =>
      services.db().user.findUnique({ where: { normalizedEmail } }),
    revokeSession: (id: string, now: Date) =>
      services.db().session.update({ where: { id }, data: { revokedAt: now } }),
    updatePreferences: (
      userId: string,
      data: Pick<Prisma.UserUpdateInput, "defaultTimezone" | "notificationPreference">,
    ): Promise<User> => services.db().user.update({ where: { id: userId }, data }),
    findOwnedTask: (id: string, userId: string) =>
      services.db().task.findFirst({ where: { id, userId } }),
    async countAttempts(globalKey: string, accountKey: string, windowSeconds: number) {
      const redis = services.redis();
      if (redis.status === "wait") await redis.connect();
      return redis.eval(rateScript, 2, globalKey, accountKey, windowSeconds);
    },
  };
}
