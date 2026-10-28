import { closeDatabase } from '@scova/db';
import { createObservedDatabase } from './query-observer.ts';
import { createDefaultServices } from '../../src/app/services.ts';
import { createStreamRegistry } from '../../src/app/streams.ts';
import { startServer } from '../../src/app/runtime.ts';

// Only this test entry injects short timing and telemetry; production uses fixed default policy.
let reads = 0,
    opened = 0,
    closed = 0;
const database = createObservedDatabase(process.env.DATABASE_URL!, {
    before(query) {
        if (/\bfrom\s+"sessions"/i.test(query.text)) reads += 1;
    },
});
const registry = createStreamRegistry();
const services = createDefaultServices({
    db: () => database,
    close: () => closeDatabase(database),
    streams: {
        register(abort, done) {
            opened += 1;
            registry.register(abort, done);
            void done.then(() => {
                closed += 1;
            });
        },
        stop: () => registry.stop(),
    },
    sse: { pollIntervalMs: 20, heartbeatMs: 100, slowClientMs: 500 },
});
startServer(process.env.SCOVA_SSE_TEST_RUNTIME === 'bun' ? 'bun' : 'node', { services });
process.on('message', (message) => {
    if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'sse:stats'
    )
        process.send?.({ type: 'sse:stats', reads, opened, closed });
});
