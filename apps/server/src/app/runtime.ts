import { createApiApp } from '@/app/index.ts';
import { createDefaultServices, type ApiServices } from '@/app/services';
import { serve } from 'srvx/node';

/** 此处使用node:http，使 Bun/Node运行时均通过 write/drain 传播 socket 背压。后续应该会改 */

export function startServer(runtime: 'bun' | 'node', options: { services?: ApiServices } = {}) {
    const services = options.services ?? createDefaultServices();
    const app = createApiApp(runtime, services).compile();
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
    console.log(`Scova API listening on http://localhost:${port}`);
    let stopping: Promise<void> | undefined;
    const stop = () =>
        (stopping ??= (async () => {
            try {
                await services.streams.stop();
                await server.close();
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
