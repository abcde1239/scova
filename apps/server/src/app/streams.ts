import { ApiError } from '@/utils/errors.ts';

export interface ApiStreamRegistry {
    register(abort: () => void, done: Promise<void>): void;
    stop(): Promise<void>;
}

/** 纯内存连接所有权；停止先广播中断，再等待在途查询与连接清理。 */
export function createStreamRegistry(): ApiStreamRegistry {
    const streams = new Map<Promise<void>, () => void>();
    let stopping: Promise<void> | undefined;
    return {
        register(abort, done) {
            if (stopping) throw new ApiError(503, 'SERVER_STOPPING', '服务正在关闭，请稍后重连');
            streams.set(done, abort);
            void done.then(
                () => streams.delete(done),
                () => streams.delete(done),
            );
        },
        stop() {
            if (!stopping) {
                let finish!: () => void;
                stopping = new Promise<void>((resolve) => {
                    finish = resolve;
                });
                const active = [...streams];
                for (const [, abort] of active) abort();
                void Promise.allSettled(active.map(([done]) => done)).then(finish);
            }
            return stopping;
        },
    };
}
