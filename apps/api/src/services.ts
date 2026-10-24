import { createRequire } from "node:module";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";

const require = createRequire(import.meta.url);

export interface AuthRateLimitConfig {
  windowSeconds: number;
  loginAttempts: number;
  registerAttempts: number;
  globalAttempts: number;
  keyPrefix: string;
}

/** 由应用装配注入的服务；文档生成只创建此对象，不构造数据库或 Redis 客户端。 */
export interface ApiServices {
  db(): PrismaClient;
  redis(): Redis;
  origin: string;
  production: boolean;
  registrationEnabled: boolean;
  sessionTtlSeconds: number;
  rateLimit: AuthRateLimitConfig;
  clock(): Date;
  close(): Promise<void>;
}

export type ApiServiceOverrides = Partial<Omit<ApiServices, "rateLimit">> & {
  rateLimit?: Partial<AuthRateLimitConfig>;
};

function positiveSetting(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`配置 ${name} 必须是正安全整数`);
  return value;
}

export function createDefaultServices(overrides: ApiServiceOverrides = {}): ApiServices {
  let database: PrismaClient | undefined;
  let cache: Redis | undefined;
  const origin = new URL(overrides.origin ?? process.env.APP_ORIGIN ?? "http://localhost:5173")
    .origin;
  const rateLimit: AuthRateLimitConfig = {
    windowSeconds: positiveSetting("AUTH_RATE_LIMIT_WINDOW_SECONDS", 60),
    loginAttempts: positiveSetting("AUTH_LOGIN_LIMIT", 10),
    registerAttempts: positiveSetting("AUTH_REGISTER_LIMIT", 10),
    globalAttempts: positiveSetting("AUTH_GLOBAL_LIMIT", 100),
    keyPrefix: "scova:auth:",
    ...overrides.rateLimit,
  };
  for (const [key, value] of Object.entries(rateLimit)) {
    if (key !== "keyPrefix" && (!Number.isSafeInteger(value) || Number(value) < 1))
      throw new Error("认证限流配置必须是正安全整数");
  }
  return {
    origin,
    production: overrides.production ?? process.env.NODE_ENV === "production",
    registrationEnabled:
      overrides.registrationEnabled ?? process.env.REGISTRATION_ENABLED !== "false",
    sessionTtlSeconds:
      overrides.sessionTtlSeconds ?? positiveSetting("SESSION_TTL_SECONDS", 7 * 24 * 60 * 60),
    rateLimit,
    clock: overrides.clock ?? (() => new Date()),
    db:
      overrides.db ??
      (() => {
        if (!database) {
          if (!process.env.DATABASE_URL) throw new Error("尚未配置业务数据库");
          const { PrismaClient: Client } =
            require("@prisma/client") as typeof import("@prisma/client");
          database = new Client();
        }
        return database;
      }),
    redis:
      overrides.redis ??
      (() => {
        if (!cache) {
          if (!process.env.REDIS_URL) throw new Error("尚未配置 Redis");
          const { Redis: Client } = require("ioredis") as typeof import("ioredis");
          cache = new Client(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            enableOfflineQueue: false,
          });
          // 错误由发起请求的认证服务转为脱敏 503；避免默认日志输出连接凭据。
          cache.on("error", () => undefined);
        }
        return cache;
      }),
    close:
      overrides.close ??
      (async () => {
        const tasks: Promise<unknown>[] = [];
        if (database) tasks.push(database.$disconnect());
        if (cache) {
          if (cache.status === "wait" || cache.status === "end") cache.disconnect();
          else tasks.push(cache.quit());
        }
        await Promise.all(tasks);
      }),
  };
}
