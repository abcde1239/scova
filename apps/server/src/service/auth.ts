import { randomBytes } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import type { User as StoredUser } from "@scova/models";
import type { LoginInput, RegisterInput, UpdatePreferencesInput } from "@scova/contracts";
import type { ApiServices } from "@/app/context.ts";
import { createAuthRepository, type AuthTransaction } from "@/repo/auth.ts";
import { ApiError } from "@/utils/errors.ts";
import { csrfForSession, isUuid, tokenHash } from "@/utils/security.ts";
import { serializeUser } from "@/utils/user.ts";

export interface AuthenticatedSession {
  id: string;
  userId: string;
  user: StoredUser;
  csrfToken: string;
  csrfTokenHash: string;
  expiresAt: Date;
}

const passwordOptions = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};
let dummyHash: Promise<string> | undefined;

/** 账号规则与会话事务，不接收 HTTP Request 或 Elysia 上下文。 */
export function createAuthService(services: ApiServices) {
  const repository = createAuthRepository(services);

  async function limitAuthentication(action: "login" | "register", email: string) {
    const policy = services.rateLimit;
    const now = services.clock().getTime();
    const window = Math.floor(now / (policy.windowSeconds * 1000));
    const remaining = policy.windowSeconds - (Math.floor(now / 1000) % policy.windowSeconds);
    const prefix = `${policy.keyPrefix}${window}:`;
    let counts: unknown;
    try {
      counts = await repository.countAttempts(
        `${prefix}global`,
        `${prefix}${action}:${tokenHash(email)}`,
        policy.windowSeconds,
      );
    } catch {
      throw new ApiError(503, "AUTH_SERVICE_UNAVAILABLE", "认证服务暂时不可用，请稍后重试");
    }
    if (!Array.isArray(counts) || counts.length !== 2)
      throw new ApiError(503, "AUTH_SERVICE_UNAVAILABLE", "认证服务暂时不可用，请稍后重试");
    const actionLimit = action === "login" ? policy.loginAttempts : policy.registerAttempts;
    if (Number(counts[0]) > policy.globalAttempts || Number(counts[1]) > actionLimit) {
      const error = new ApiError(429, "RATE_LIMITED", "尝试过于频繁，请稍后重试");
      error.retryAfterSeconds = remaining;
      throw error;
    }
  }

  async function newSession(store: AuthTransaction, user: StoredUser, previousToken?: string) {
    const now = services.clock();
    if (previousToken) await store.revokePrevious(tokenHash(previousToken), now);
    const token = randomBytes(32).toString("base64url");
    const csrfToken = csrfForSession(token);
    const expiresAt = new Date(now.getTime() + services.sessionTtlSeconds * 1000);
    if (!Number.isFinite(expiresAt.getTime()))
      throw new ApiError(500, "SESSION_CONFIGURATION_INVALID", "会话配置不可用");
    await store.createSession({
      userId: user.id,
      tokenHash: tokenHash(token),
      csrfTokenHash: tokenHash(csrfToken),
      expiresAt,
    });
    // 在提交前验证公开字段，避免无效历史数据导致旧会话已撤销却无法交付新会话。
    serializeUser(user);
    return { token, session: { user, csrfToken } };
  }

  return {
    async authenticate(token?: string): Promise<AuthenticatedSession> {
      if (!token) throw new ApiError(401, "SESSION_REQUIRED", "请先登录");
      const session = await repository.findSession(tokenHash(token));
      if (!session || session.revokedAt !== null || session.expiresAt <= services.clock())
        throw new ApiError(401, "SESSION_REQUIRED", "请先登录");
      return {
        id: session.id,
        userId: session.userId,
        user: session.owner,
        csrfToken: csrfForSession(token),
        csrfTokenHash: session.csrfTokenHash,
        expiresAt: session.expiresAt,
      };
    },
    async register(input: RegisterInput, previousToken?: string) {
      if (!services.registrationEnabled)
        throw new ApiError(403, "REGISTRATION_DISABLED", "当前部署已关闭注册");
      const email = input.email.toLowerCase();
      await limitAuthentication("register", email);
      const passwordHash = await hash(input.password, passwordOptions);
      try {
        return await repository.transaction(async (store) => {
          const user = await store.createUser({
            email: input.email,
            normalizedEmail: email,
            passwordHash,
            defaultTimezone: input.defaultTimezone,
          });
          return newSession(store, user, previousToken);
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2002"
        )
          throw new ApiError(409, "EMAIL_ALREADY_REGISTERED", "该邮箱已注册");
        throw error;
      }
    },
    async login(input: LoginInput, previousToken?: string) {
      const email = input.email.toLowerCase();
      await limitAuthentication("login", email);
      const user = await repository.findUser(email);
      const passwordHash =
        user?.passwordHash ??
        (await (dummyHash ??= hash(randomBytes(32).toString("base64url"), passwordOptions)));
      const valid = await verify(passwordHash, input.password);
      if (!user || !valid) throw new ApiError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确");
      return repository.transaction((store) => newSession(store, user, previousToken));
    },
    revoke: (session: AuthenticatedSession) =>
      repository.revokeSession(session.id, services.clock()),
    updatePreferences: (session: AuthenticatedSession, input: UpdatePreferencesInput) =>
      repository.updatePreferences(session.userId, {
        ...(input.defaultTimezone === undefined ? {} : { defaultTimezone: input.defaultTimezone }),
        ...(input.notificationPreference === undefined
          ? {}
          : { notificationPreference: input.notificationPreference }),
      }),
    async ownedTask(taskId: string, session: Pick<AuthenticatedSession, "userId">) {
      if (!isUuid(taskId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
      const task = await repository.findOwnedTask(taskId, session.userId);
      if (!task) throw new ApiError(404, "NOT_FOUND", "资源不存在");
      return task;
    },
  };
}
