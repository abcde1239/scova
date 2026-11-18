import { ConnectorError, type ReadDiagnostic, type ReadDiagnosticPhase } from '../types.ts';

const phases: ReadDiagnosticPhase[] = [
    'host',
    'queue',
    'dispatch',
    'attempt',
    'http',
    'dns',
    'headers',
    'body',
    'extract',
    'render',
    'cleanup',
];

/** Internal diagnostics contain fixed labels and numbers only, never URLs, bodies or error messages. */
export function isReadDiagnostic(value: unknown): value is ReadDiagnostic {
    if (!value || typeof value !== 'object') return false;
    const event = value as ReadDiagnostic;
    return (
        phases.includes(event.phase) &&
        ['start', 'end', 'error'].includes(event.state) &&
        [event.elapsedMs, event.remainingMs, event.durationMs ?? 0].every(
            (n) => Number.isFinite(n) && n >= 0,
        ) &&
        (event.code === undefined ||
            [
                'configuration',
                'balance_unsupported',
                'unsafe_url',
                'network',
                'timeout',
                'aborted',
                'response_too_large',
                'http',
                'invalid_response',
                'output_truncated',
                'model_quota_exceeded',
                'search_unavailable',
                'budget_exceeded',
                'extraction_failed',
            ].includes(event.code))
    );
}

export function readDiagnostics(
    observer: ((event: ReadDiagnostic) => void) | undefined,
    timeoutMs: number,
) {
    const started = performance.now();
    let count = 0;
    const emit = (event: ReadDiagnostic) => {
        if (!observer || count++ >= 64) return;
        try {
            observer(event);
        } catch {
            /* Observability cannot alter tool behavior. */
        }
    };
    const beginStage = (phase: ReadDiagnosticPhase) => {
        const begin = performance.now();
        const report = (state: ReadDiagnostic['state'], error?: unknown) => {
            const now = performance.now();
            emit({
                phase,
                state,
                elapsedMs: Math.round(now - started),
                remainingMs: Math.max(0, Math.round(timeoutMs - (now - started))),
                ...(state === 'start' ? {} : { durationMs: Math.round(now - begin) }),
                ...(error instanceof ConnectorError ? { code: error.code } : {}),
            });
        };
        report('start');
        let finished = false;
        return (error?: unknown) => {
            if (finished) return;
            finished = true;
            report(error === undefined ? 'end' : 'error', error);
        };
    };
    return {
        begin: beginStage,
        relay: (event: ReadDiagnostic) => {
            if (isReadDiagnostic(event))
                emit({
                    phase: event.phase,
                    state: event.state,
                    elapsedMs: event.elapsedMs,
                    remainingMs: event.remainingMs,
                    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
                    ...(event.code === undefined ? {} : { code: event.code }),
                });
        },
        async stage<T>(phase: ReadDiagnosticPhase, operation: () => Promise<T>): Promise<T> {
            const finish = beginStage(phase);
            try {
                const value = await operation();
                finish();
                return value;
            } catch (error) {
                finish(error);
                throw error;
            }
        },
    };
}
