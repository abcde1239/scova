import { writeFile, unlink } from 'node:fs/promises';
import { readWorkerConfig, type WorkerConfig } from '@/app/config.ts';
import { createWorkerResources, type WorkerResources } from '@/app/resources.ts';
import { waitForPoll } from '@/utils/wait.ts';
import type { ConnectorBundle } from '@scova/connectors';
import type { RunExecutor } from '@/service/runs.ts';

export interface WorkerAppOptions {
    config?: WorkerConfig;
    resources?: WorkerResources;
    logger?: Pick<Console, 'info'>;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    executor?: RunExecutor;
    bundle?: ConnectorBundle;
}

/** 启动 consumer、更新就绪心跳、清理与幂等停止；构造时不连接外部服务。 */
export function createWorkerApp(options: WorkerAppOptions = {}) {
    const config = options.config ?? readWorkerConfig();
    const resources =
        options.resources ??
        createWorkerResources(config, { executor: options.executor, bundle: options.bundle });
    const logger = options.logger ?? console;
    const wait = options.wait ?? waitForPoll;
    const controller = new AbortController();
    const { signal } = controller;
    let starting: Promise<void> | undefined;
    let consumer: Promise<void> | undefined;
    let heartbeat: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= resources.close());
    const heartbeatPath = process.env.WORKER_HEARTBEAT_PATH;

    function clearHeartbeat() {
        return heartbeatPath
            ? unlink(heartbeatPath).catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== 'ENOENT') throw error;
              })
            : Promise.resolve();
    }
    async function watchReadiness(path: string) {
        while (!signal.aborted) {
            if (resources.isReady()) await writeFile(path, 'ready\n', { mode: 0o600 });
            else await clearHeartbeat();
            await wait(10_000, signal);
        }
    }

    const start = () => {
        if (signal.aborted) return Promise.reject(new Error('Worker 已停止，不能重新启动'));
        return (starting ??= (async () => {
            try {
                await clearHeartbeat();
                await resources.connect(signal);
                consumer = resources.finished();
                void consumer.catch(() => controller.abort());
                if (signal.aborted) return;
                if (heartbeatPath) {
                    heartbeat = watchReadiness(heartbeatPath);
                    void heartbeat.catch(() => controller.abort());
                }
                logger.info('Scova worker ready; Run consumer running');
            } catch (error) {
                controller.abort();
                try {
                    await close();
                } catch (closeError) {
                    throw new AggregateError([error, closeError], 'Worker 启动失败且资源清理失败');
                }
                throw error;
            }
        })());
    };
    const stop = () =>
        (stopping ??= (async () => {
            controller.abort();
            await starting?.catch(() => undefined);
            try {
                const settled = await Promise.allSettled([resources.stop(), heartbeat, consumer]);
                const failures = settled.filter((result) => result.status === 'rejected');
                if (failures.length)
                    throw new AggregateError(
                        failures.map((result) => result.reason),
                        'Worker 在途操作停止失败',
                    );
            } finally {
                try {
                    await clearHeartbeat();
                } finally {
                    await close();
                }
            }
        })());
    const finished = async () => {
        if (!starting) throw new Error('Worker 尚未启动');
        await starting;
        await Promise.all([consumer, heartbeat]);
    };
    return { start, stop, finished };
}
