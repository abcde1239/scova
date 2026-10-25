import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma, User as StoredUser } from "@prisma/client";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { Elysia } from "elysia";
import {
  ApiErrorSchema,
  LoginInputSchema,
  RegisterInputSchema,
  SessionResponseSchema,
  UpdatePreferencesInputSchema,
  UserSchema,
  parseContract,
  type SessionResponse,
  type User,
} from "@scova/contracts";
import type { ApiServices } from "./services.ts";
import { ApiError } from "./errors.ts";

export const SESSION_COOKIE_NAME = "scova_session";
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
const csrfForSession = (token: string) =>
  createHmac("sha256", token).update("scova.csrf.v1").digest("base64url");
const passwordOptions = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};
let dummyHash: Promise<string> | undefined;

export interface AuthenticatedSession {
  id: string;
  userId: string;
  user: StoredUser;
  csrfToken: string;
  csrfTokenHash: string;
  expiresAt: Date;
}

function presentedToken(request: Request): string | undefined {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (values.length !== 1) return undefined;
  const token = values[0]!.slice(SESSION_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
export function requireOrigin(request: Request, services: ApiServices): void {
  if (
    request.headers.get("origin") !== services.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new ApiError(403, "ORIGIN_REJECTED", "请求来源不受信任");
}
export async function requireSession(
  request: Request,
  services: ApiServices,
): Promise<AuthenticatedSession> {
  const token = presentedToken(request);
  if (!token) throw new ApiError(401, "SESSION_REQUIRED", "请先登录");
  const session = await services
    .db()
    .session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { owner: true } });
  if (
    !session ||
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= services.clock().getTime()
  )
    throw new ApiError(401, "SESSION_REQUIRED", "请先登录");
  return {
    id: session.id,
    userId: session.userId,
    user: session.owner,
    csrfToken: csrfForSession(token),
    csrfTokenHash: session.csrfTokenHash,
    expiresAt: session.expiresAt,
  };
}
export function requireCsrf(
  request: Request,
  session: AuthenticatedSession,
  services: ApiServices,
): void {
  requireOrigin(request, services);
  const csrf = request.headers.get("x-csrf-token");
  if (
    !csrf ||
    csrf.length > 128 ||
    !timingSafeEqual(Buffer.from(tokenHash(csrf), "hex"), Buffer.from(session.csrfTokenHash, "hex"))
  )
    throw new ApiError(403, "CSRF_REJECTED", "请求校验失败，请刷新后重试");
}
export async function requireOwnedTask(
  taskId: string,
  session: AuthenticatedSession,
  services: ApiServices,
  database: Pick<Prisma.TransactionClient, "task"> = services.db(),
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId))
    throw new ApiError(404, "NOT_FOUND", "资源不存在");
  const task = await database.task.findFirst({ where: { id: taskId, userId: session.userId } });
  if (!task) throw new ApiError(404, "NOT_FOUND", "资源不存在");
  return task;
}
export function serializeUser(user: StoredUser): User {
  return parseContract(UserSchema, {
    id: user.id,
    email: user.email,
    preferences: {
      defaultTimezone: user.defaultTimezone,
      notificationPreference: user.notificationPreference,
    },
    createdAt: user.createdAt.toISOString(),
  });
}
export function serializeSession(
  session: Pick<AuthenticatedSession, "user" | "csrfToken">,
): SessionResponse {
  return { user: serializeUser(session.user), csrfToken: session.csrfToken };
}

const rateScript = `local a=redis.call('INCR',KEYS[1]); if a==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local b=redis.call('INCR',KEYS[2]); if b==1 then redis.call('EXPIRE',KEYS[2],ARGV[1]) end; return {a,b}`;
async function limitAuthentication(
  services: ApiServices,
  action: "login" | "register",
  email: string,
) {
  const policy = services.rateLimit;
  const now = services.clock().getTime();
  const window = Math.floor(now / (policy.windowSeconds * 1000));
  const remaining = policy.windowSeconds - (Math.floor(now / 1000) % policy.windowSeconds);
  const prefix = `${policy.keyPrefix}${window}:`;
  let counts: unknown;
  try {
    const redis = services.redis();
    if (redis.status === "wait") await redis.connect();
    counts = await redis.eval(
      rateScript,
      2,
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
function cookie(services: ApiServices, token?: string): string {
  return `${SESSION_COOKIE_NAME}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? services.sessionTtlSeconds : 0}${token ? "" : "; Expires=Thu, 01 Jan 1970 00:00:00 GMT"}${services.production ? "; Secure" : ""}`;
}
async function newSession(
  database: Prisma.TransactionClient,
  user: StoredUser,
  request: Request,
  services: ApiServices,
) {
  const now = services.clock();
  const previous = presentedToken(request);
  if (previous)
    await database.session.updateMany({
      where: { tokenHash: tokenHash(previous), revokedAt: null },
      data: { revokedAt: now },
    });
  const token = randomBytes(32).toString("base64url");
  const csrfToken = csrfForSession(token);
  const expiresAt = new Date(now.getTime() + services.sessionTtlSeconds * 1000);
  if (!Number.isFinite(expiresAt.getTime()))
    throw new ApiError(500, "SESSION_CONFIGURATION_INVALID", "会话配置不可用");
  await database.session.create({
    data: {
      userId: user.id,
      tokenHash: tokenHash(token),
      csrfTokenHash: tokenHash(csrfToken),
      expiresAt,
    },
  });
  return { token, response: serializeSession({ user, csrfToken }) };
}
const errorResponses = {
  400: "ApiError",
  401: "ApiError",
  403: "ApiError",
  409: "ApiError",
  422: "ApiError",
  429: "ApiError",
  500: "ApiError",
  503: "ApiError",
} as const;

export function createAuthPlugin(services: ApiServices) {
  return new Elysia({ name: "scova-auth", prefix: "/api/v1", normalize: false })
    .model({
      ApiError: ApiErrorSchema,
      RegisterInput: RegisterInputSchema,
      LoginInput: LoginInputSchema,
      SessionResponse: SessionResponseSchema,
      UpdatePreferencesInput: UpdatePreferencesInputSchema,
    })
    .onBeforeHandle(({ set }) => {
      set.headers["cache-control"] = "no-store";
    })
    .post(
      "/auth/register",
      async ({ body, request, set }) => {
        requireOrigin(request, services);
        if (!services.registrationEnabled)
          throw new ApiError(403, "REGISTRATION_DISABLED", "当前部署已关闭注册");
        const input = parseContract(RegisterInputSchema, body);
        const email = input.email.toLowerCase();
        await limitAuthentication(services, "register", email);
        const passwordHash = await hash(input.password, passwordOptions);
        let created;
        try {
          created = await services.db().$transaction(async (transaction) => {
            const user = await transaction.user.create({
              data: {
                email: input.email,
                normalizedEmail: email,
                passwordHash,
                defaultTimezone: input.defaultTimezone,
              },
            });
            return newSession(transaction, user, request, services);
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
        set.status = 201;
        set.headers["set-cookie"] = cookie(services, created.token);
        return created.response;
      },
      {
        body: "RegisterInput",
        response: { 201: "SessionResponse", ...errorResponses },
        detail: {
          operationId: "registerAccount",
          tags: ["账号"],
          summary: "邮箱密码注册",
          description: "同源注册并创建安全 Cookie 会话；密码以 Argon2id 哈希保存，不要求邮件服务。",
        },
      },
    )
    .post(
      "/auth/login",
      async ({ body, request, set }) => {
        requireOrigin(request, services);
        const input = parseContract(LoginInputSchema, body);
        const email = input.email.toLowerCase();
        await limitAuthentication(services, "login", email);
        const user = await services.db().user.findUnique({ where: { normalizedEmail: email } });
        const passwordHash =
          user?.passwordHash ??
          (await (dummyHash ??= hash(randomBytes(32).toString("base64url"), passwordOptions)));
        const valid = await verify(passwordHash, input.password);
        if (!user || !valid) throw new ApiError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确");
        const created = await services
          .db()
          .$transaction((transaction) => newSession(transaction, user, request, services));
        set.headers["set-cookie"] = cookie(services, created.token);
        return created.response;
      },
      {
        body: "LoginInput",
        response: { 200: "SessionResponse", ...errorResponses },
        detail: {
          operationId: "loginAccount",
          tags: ["账号"],
          summary: "邮箱密码登录",
          description:
            "执行 Redis 跨实例限流；成功后更换随机会话 token，Cookie 不在响应 JSON 中返回。",
        },
      },
    )
    .post(
      "/auth/logout",
      async ({ request, set }) => {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        await services
          .db()
          .session.update({ where: { id: session.id }, data: { revokedAt: services.clock() } });
        set.headers["set-cookie"] = cookie(services);
        set.status = 204;
        return new Response(null, { status: 204 });
      },
      {
        detail: {
          operationId: "logoutAccount",
          tags: ["账号"],
          summary: "注销当前会话",
          description: "要求同源 Origin 与 CSRF 校验，撤销持久化会话并清理 Cookie。",
          responses: { 204: { description: "会话已注销，无响应体" } },
        },
      },
    )
    .get("/me", async ({ request }) => serializeSession(await requireSession(request, services)), {
      response: { 200: "SessionResponse", ...errorResponses },
      detail: {
        operationId: "getCurrentSession",
        tags: ["账号"],
        summary: "恢复当前会话",
        description: "返回当前用户及稳定 CSRF 值，不返回会话 token、密码哈希或内部记录。",
      },
    })
    .patch(
      "/me/preferences",
      async ({ body, request }) => {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        const input = parseContract(UpdatePreferencesInputSchema, body);
        const user = await services.db().user.update({
          where: { id: session.userId },
          data: {
            ...(input.defaultTimezone === undefined
              ? {}
              : { defaultTimezone: input.defaultTimezone }),
            ...(input.notificationPreference === undefined
              ? {}
              : { notificationPreference: input.notificationPreference }),
          },
        });
        return serializeSession({ user, csrfToken: session.csrfToken });
      },
      {
        body: "UpdatePreferencesInput",
        response: { 200: "SessionResponse", ...errorResponses },
        detail: {
          operationId: "updateCurrentPreferences",
          tags: ["账号"],
          summary: "修改默认时区与提醒偏好",
          description: "只修改当前账号默认设置，不追溯改变已保存任务配置版本。",
        },
      },
    );
}
