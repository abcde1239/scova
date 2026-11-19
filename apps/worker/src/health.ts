import { stat } from 'node:fs/promises';

try {
    // A fresh heartbeat proves the Worker connected and can still advance its background loop.
    const file = await stat(process.env.WORKER_HEARTBEAT_PATH ?? '/tmp/scova-worker-ready');
    if (!file.isFile() || Date.now() - file.mtimeMs > 45_000) throw new Error('Worker 心跳已过期');
} catch {
    process.exitCode = 1;
}
