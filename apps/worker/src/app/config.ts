import { executionTokenPattern } from '@scova/shared/execution/protocol';
import { readRunQueueName } from '@scova/shared/outbox-job';

export interface WorkerConfig {
    executionUrl: string;
    executionToken: string;
    redisUrl: string;
    queueName: string;
    runLeaseSeconds: number;
    runConcurrency: number;
}

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error(`${name} 必须为 1 至 ${maximum} 的整数`);
    return value;
}

function connectionUrl(env: NodeJS.ProcessEnv, name: string, protocols: string[]) {
    try {
        const input = env[name];
        if (!input) throw new Error();
        const url = new URL(input);
        if (!protocols.includes(url.protocol) || !url.hostname) throw new Error();
        return input;
    } catch {
        throw new Error(`${name} 缺失或连接地址无效`);
    }
}

/** 缺配置明确失败，错误仅指出变量名，不包含连接凭据。 */
export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
    const executionToken = env.WORKER_EXECUTION_TOKEN;
    if (!executionToken || !executionTokenPattern.test(executionToken))
        throw new Error('WORKER_EXECUTION_TOKEN 缺失或无效');
    const executionUrl = connectionUrl(
        { ...env, WORKER_EXECUTION_URL: env.WORKER_EXECUTION_URL ?? 'http://127.0.0.1:3001' },
        'WORKER_EXECUTION_URL',
        ['http:', 'https:'],
    );
    const url = new URL(executionUrl);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw new Error('WORKER_EXECUTION_URL 缺失或连接地址无效');
    return {
        executionUrl,
        executionToken,
        redisUrl: !env.REDIS_URL ? '' : connectionUrl(env, 'REDIS_URL', ['redis:', 'rediss:']),
        queueName: readRunQueueName(env),
        runLeaseSeconds: integerSetting(env, 'WORKER_RUN_LEASE_SECONDS', 30, 3600),
        runConcurrency: integerSetting(env, 'WORKER_RUN_CONCURRENCY', 2, 32),
    };
}
