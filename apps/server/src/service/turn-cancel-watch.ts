import { setTimeout as delay } from 'node:timers/promises';
import { withDeadline } from '@scova/connectors';

export function watchTurnCancellation(
    turn: AbortController,
    isRunning: () => Promise<boolean>,
): () => Promise<void> {
    const monitor = new AbortController();
    const watching = (async () => {
        try {
            while (!turn.signal.aborted) {
                await delay(250, undefined, { signal: monitor.signal });
                if (turn.signal.aborted) return;
                if (!(await withDeadline(1000, monitor.signal, isRunning))) turn.abort();
            }
        } catch (error) {
            if (!monitor.signal.aborted) turn.abort(error);
        }
    })();
    return async () => {
        monitor.abort();
        await watching;
    };
}
