import type { DatabaseClient } from '@scova/db';
import { createThreadRunResultRepository } from '@/repo/thread-run-results.ts';

export function createThreadRunResultBatch(
    db: DatabaseClient,
    batchSize: number,
    clock: () => Date = () => new Date(),
) {
    const repository = createThreadRunResultRepository(db);
    return async (signal?: AbortSignal) => {
        let delivered = 0;
        while (delivered < batchSize && !signal?.aborted && (await repository.deliverNext(clock())))
            delivered += 1;
        return delivered;
    };
}
