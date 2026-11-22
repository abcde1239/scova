import { createDatabaseClient, closeDatabase, type DatabaseClient } from '@scova/db';
import { listProviderModels, readProviderBalance, type ModelProvider } from '@scova/connectors';
import {
    createTaskDraftModel,
    createTaskDraftPolicy,
    type TaskDraftPolicy,
} from '@/app/task-drafts.ts';
import { createStreamRegistry, type ApiStreamRegistry } from '@/app/streams.ts';
import { DEFAULT_SSE_POLICY, type SsePolicy } from '@/utils/sse.ts';
import { createAgentProviderService } from '@/service/agent-providers';
import { createImageStorageView, type ImageStorageClient } from '@scova/object-storage/image';
import type { ObjectStorage } from '@scova/object-storage';
import { createBucketStorage } from '@/app/object-storage';
import { openSqliteState, readSqliteStatePath, type SqliteState } from '@scova/db/sqlite-state';
import { createRedisConnection } from '@/repo/redis.ts';

type Redis = ReturnType<typeof createRedisConnection>;

export interface AuthRateLimitConfig {
    windowSeconds: number;
    loginAttempts: number;
    registerAttempts: number;
    globalAttempts: number;
    keyPrefix: string;
}

/** 接口文档生成只创建此对象，不构造数据库或 Redis 客户端。 */
export interface ApiServices {
    db(): DatabaseClient;
    redis(): Redis;
    sqliteState?(): SqliteState;
    origin: string;
    production: boolean;
    registrationEnabled: boolean;
    sessionTtlSeconds: number;
    rateLimit: AuthRateLimitConfig;
    taskDraftPolicy: TaskDraftPolicy;
    reportQuestionPolicy: TaskDraftPolicy;
    reportQuestionModel(userId?: string): ModelProvider | null | Promise<ModelProvider | null>;
    taskDraftModel(userId?: string): ModelProvider | null | Promise<ModelProvider | null>;
    providerModels: typeof listProviderModels;
    providerBalance: typeof readProviderBalance;
    objectStorage(): ObjectStorage | null;
    avatarStorage(): ImageStorageClient | null;
    streams: ApiStreamRegistry;
    sse: SsePolicy;
    clock(): Date;
    close(): Promise<void>;
}

export type ApiServiceOverrides = Partial<
    Omit<ApiServices, 'rateLimit' | 'sse' | 'taskDraftPolicy' | 'reportQuestionPolicy'>
> & {
    rateLimit?: Partial<AuthRateLimitConfig>;
    sse?: Partial<SsePolicy>;
    taskDraftPolicy?: Partial<TaskDraftPolicy>;
    reportQuestionPolicy?: Partial<TaskDraftPolicy>;
};

function positiveSetting(name: string, fallback: number): number {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`配置 ${name} 必须是正安全整数`);
    return value;
}

export function createDefaultServices(overrides: ApiServiceOverrides = {}): ApiServices {
    let database: DatabaseClient | undefined;
    let cache: Redis | undefined;
    let localState: SqliteState | undefined;
    const sqlitePath = readSqliteStatePath();
    let draftModel: ModelProvider | null | undefined;
    let questionModel: ModelProvider | null | undefined;
    let images: ImageStorageClient | null | undefined;
    let bucket: ObjectStorage | null | undefined;
    const streams = overrides.streams ?? createStreamRegistry();
    let closing: Promise<void> | undefined;
    const origin = new URL(overrides.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:5173')
        .origin;
    const rateLimit: AuthRateLimitConfig = {
        windowSeconds: positiveSetting('AUTH_RATE_LIMIT_WINDOW_SECONDS', 60),
        loginAttempts: positiveSetting('AUTH_LOGIN_LIMIT', 10),
        registerAttempts: positiveSetting('AUTH_REGISTER_LIMIT', 10),
        globalAttempts: positiveSetting('AUTH_GLOBAL_LIMIT', 100),
        keyPrefix: 'scova:auth:',
        ...overrides.rateLimit,
    };
    for (const [key, value] of Object.entries(rateLimit)) {
        if (key !== 'keyPrefix' && (!Number.isSafeInteger(value) || Number(value) < 1))
            throw new Error('认证限流配置必须是正安全整数');
    }
    const services: ApiServices = {
        providerModels: overrides.providerModels ?? listProviderModels,
        providerBalance: overrides.providerBalance ?? readProviderBalance,
        objectStorage:
            overrides.objectStorage ??
            (() => {
                if (closing) throw new Error('文件存储已关闭');
                if (bucket === undefined) bucket = createBucketStorage();
                return bucket;
            }),
        avatarStorage:
            overrides.avatarStorage ??
            (() => {
                if (closing) throw new Error('文件存储已关闭');
                if (images === undefined) {
                    const shared = services.objectStorage();
                    images = shared ? createImageStorageView(shared) : null;
                }
                return images;
            }),
        origin,
        production: overrides.production ?? process.env.NODE_ENV === 'production',
        registrationEnabled:
            overrides.registrationEnabled ?? process.env.REGISTRATION_ENABLED !== 'false',
        sessionTtlSeconds:
            overrides.sessionTtlSeconds ?? positiveSetting('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),
        rateLimit,
        taskDraftPolicy: createTaskDraftPolicy(overrides.taskDraftPolicy),
        reportQuestionPolicy: createTaskDraftPolicy({
            keyPrefix: 'scova:report-questions:',
            ...overrides.reportQuestionPolicy,
        }),
        reportQuestionModel:
            overrides.reportQuestionModel ??
            (async (userId) => {
                const own = userId
                    ? await createAgentProviderService(services).model(userId)
                    : null;
                if (own) return own;
                if (questionModel === undefined) questionModel = createTaskDraftModel();
                return questionModel;
            }),
        taskDraftModel:
            overrides.taskDraftModel ??
            (async (userId) => {
                const own = userId
                    ? await createAgentProviderService(services).model(userId, 'task_draft')
                    : null;
                if (own) return own;
                if (draftModel === undefined) draftModel = createTaskDraftModel();
                return draftModel;
            }),
        streams,
        sse: { ...DEFAULT_SSE_POLICY, ...overrides.sse },
        clock: overrides.clock ?? (() => new Date()),
        db:
            overrides.db ??
            (() => {
                if (!database) {
                    if (!process.env.DATABASE_URL) throw new Error('尚未配置业务数据库');
                    database = createDatabaseClient({ applicationName: 'scova-api' });
                }
                return database;
            }),
        sqliteState:
            overrides.sqliteState ??
            (sqlitePath ? () => (localState ??= openSqliteState(sqlitePath)) : undefined),
        redis:
            overrides.redis ??
            (() => {
                if (!cache) {
                    if (!process.env.REDIS_URL) throw new Error('尚未配置 Redis');
                    cache = createRedisConnection(process.env.REDIS_URL);
                }
                return cache;
            }),
        close: () =>
            (closing ??= (async () => {
                await streams.stop();
                bucket?.destroy();
                localState?.close();
                if (overrides.close) {
                    await overrides.close();
                    return;
                }
                const tasks: Promise<unknown>[] = [];
                if (database) tasks.push(closeDatabase(database));
                if (cache) {
                    if (cache.status === 'wait' || cache.status === 'end') cache.disconnect();
                    else tasks.push(cache.quit());
                }
                await Promise.all(tasks);
            })()),
    };
    return services;
}
