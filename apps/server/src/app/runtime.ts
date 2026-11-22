import { createApiApp } from '@/app/index.ts';
import { createDefaultServices, type ApiServices } from '@/app/services';
import { serve } from 'srvx/node';
import { createRunControl } from '@/app/run-control.ts';
import { readSqliteStatePath } from '@scova/db/sqlite-state';
import { startWorkerExecution } from './worker-execution.ts';

// Bun 为主运行时，Node 为兼容运行时；共用 node:http 以保持 SSE 的 write/drain 背压。

export function startServer(
    runtime: 'bun' | 'node',
    options: { services?: ApiServices; runControl?: boolean } = {},
) {
    const controlEnabled =
        options.runControl ??
        (!options.services &&
            Boolean(process.env.DATABASE_URL && (readSqliteStatePath() || process.env.REDIS_URL)));
    const runControl = controlEnabled ? createRunControl() : undefined;
    const services = options.services ?? createDefaultServices();
    const app = createApiApp(runtime, services).compile();
    const workerExecution = startWorkerExecution(() => services.db());
    const port = Number(process.env.PORT ?? 3000);
    const server = serve({
        port,
        silent: true,
        gracefulShutdown: false,
        fetch(request) {
            const node = request.runtime?.node;
            if (node?.res) {
                const { req, res } = node;
                // Bun 1.3 的客户端断开只触发 req.aborted，不自动关闭 ServerResponse。
                // 主动 destroy 使 srvx 的取消与 Request.signal 清理路径保持一致。
                const abort = () => res.destroy();
                const cleanup = () => {
                    req.off('aborted', abort);
                    res.off('close', cleanup);
                    res.off('finish', cleanup);
                };
                req.once('aborted', abort);
                res.once('close', cleanup);
                res.once('finish', cleanup);
                if (req.aborted) abort();
            }
            return app.fetch(request);
        },
    });
    runControl?.start();
    console.log(`Scova API listening on http://localhost:${port}`);
    let stopping: Promise<void> | undefined;
    const stop = () =>
        (stopping ??= (async () => {
            try {
                const results = await Promise.allSettled([
                    runControl?.stop(),
                    workerExecution?.stop(),
                    services.streams.stop().then(() => server.close()),
                ]);
                const failure = results.find((result) => result.status === 'rejected');
                if (failure?.status === 'rejected') throw failure.reason;
            } finally {
                try {
                    await services.close();
                } finally {
                    process.disconnect?.();
                }
            }
        })());
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            void stop();
        });
    }
    if (process.connected)
        process.on('message', (message) => {
            if (message === 'scova:shutdown') void stop();
        });
    return { app, stop };
}
