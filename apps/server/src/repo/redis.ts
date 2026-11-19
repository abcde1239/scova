import { createRequire } from 'node:module';
import type { RedisOptions } from 'ioredis';

const require = createRequire(import.meta.url);

/** 只在运行时调用方需要 Redis 时构造；调用方拥有连接的生命周期。 */
export function createRedisConnection(
    redisUrl: string,
    options: Pick<RedisOptions, 'retryStrategy'> = {},
) {
    const { Redis } = require('ioredis') as typeof import('ioredis');
    const redis = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        commandTimeout: 5000,
        ...options,
    });
    // 上层只报告脱敏错误，不让驱动的默认日志暴露连接信息。
    redis.on('error', () => undefined);
    return redis;
}

/** 维护命令只探测一次，不将基础设施失败转为无限重试。 */
export async function assertRedisReady(redisUrl: string) {
    const redis = createRedisConnection(redisUrl, { retryStrategy: () => null });
    try {
        await redis.connect();
        if ((await redis.ping()) !== 'PONG') throw new Error('Redis 未就绪');
    } finally {
        redis.disconnect();
    }
}
