import {
    createSafeHttpClient,
    positiveLimit,
    withDeadline,
    type HttpResponse,
    type SafeHttpClient,
} from './index.ts';
import {
    ConnectorError,
    MODEL_CALL_TIMEOUT_MS,
    type CallContext,
    type ConnectorKind,
} from '../types.ts';

export interface ProviderOptions {
    apiKey: string;
    http?: SafeHttpClient;
    maxAttempts?: number;
    retryDelayMs?: number;
}

export function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJson(body: string): unknown {
    try {
        return JSON.parse(body);
    } catch {
        throw new ConnectorError('invalid_response', '供应商响应不是有效 JSON');
    }
}

const modelQuotaCodes = new Set([
    'insufficient_quota',
    'insufficient_balance',
    'balance_insufficient',
    'billing_hard_limit_reached',
    'credit_balance_too_low',
    'insufficient_credits',
    'insufficient_user_quota',
]);

function modelQuotaFailure(response: HttpResponse): boolean {
    if (response.status === 402) return true;
    try {
        const body: unknown = JSON.parse(response.body);
        if (!record(body)) return false;
        const error = record(body.error) ? body.error : body;
        return [error.code, error.type].some(
            (code) => typeof code === 'string' && modelQuotaCodes.has(code),
        );
    } catch {
        return false;
    }
}

function checkResponse(response: HttpResponse, kind: ConnectorKind): void {
    if (response.status < 200 || response.status >= 300) {
        if (kind === 'model' && modelQuotaFailure(response))
            throw new ConnectorError(
                'model_quota_exceeded',
                '模型服务额度不足，请补充额度后新建执行',
                false,
                response.status,
            );
        const error = new ConnectorError(
            'http',
            '供应商请求失败',
            response.status === 429 || response.status >= 500,
            response.status,
        );
        const retryAfter = response.headers['retry-after'];
        if (retryAfter) {
            const seconds = Number(retryAfter);
            const delay = Number.isFinite(seconds)
                ? seconds * 1000
                : Date.parse(retryAfter) - Date.now();
            if (Number.isFinite(delay) && delay > 0)
                error.retryAfterMs = Math.min(delay, 7 * 86_400_000);
        }
        throw error;
    }
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const done = () => {
            signal.removeEventListener('abort', abort);
            resolve();
        };
        // Keep long Retry-After intact; the enclosing deadline cancels the wait.
        const timer = setTimeout(done, Math.min(Math.max(ms, 0), 7 * 86_400_000));
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
}

export function prepareProvider(
    options: Omit<ProviderOptions, 'apiKey'> & { readTimeoutMs?: number },
) {
    const attempts = positiveLimit(options.maxAttempts ?? 3, 3, '尝试次数');
    const delay = options.retryDelayMs ?? 200;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 5_000)
        throw new ConnectorError('configuration', '重试间隔无效');
    const http = options.http ?? createSafeHttpClient();
    const readTimeoutMs = positiveLimit(options.readTimeoutMs ?? 15_000, 120_000, '读取超时上限');
    return {
        http,
        async call(
            kind: ConnectorKind,
            context: CallContext,
            operation: (signal: AbortSignal) => Promise<HttpResponse>,
        ) {
            const limit =
                kind === 'model' ? MODEL_CALL_TIMEOUT_MS : kind === 'read' ? readTimeoutMs : 15_000;
            return withDeadline(
                Math.min(context.timeoutMs ?? limit, limit),
                context.signal,
                async (signal) => {
                    let previousFailure: ConnectorError | undefined;
                    for (let attempt = 0; ; attempt++) {
                        if (signal.aborted) throw signal.reason;
                        if (previousFailure) await context.beforeAttempt?.(kind, previousFailure);
                        else await context.beforeAttempt?.(kind);
                        if (signal.aborted) throw signal.reason;
                        let response: HttpResponse | undefined;
                        try {
                            response = await operation(signal);
                            checkResponse(response, kind);
                            return response;
                        } catch (error) {
                            if (
                                !(error instanceof ConnectorError) ||
                                !error.retryable ||
                                attempt + 1 >= attempts
                            )
                                throw error;
                            previousFailure = error;
                            await pause(
                                Math.max(
                                    delay * 2 ** attempt + Math.floor(Math.random() * delay),
                                    error.retryAfterMs ?? 0,
                                ),
                                signal,
                            );
                        }
                    }
                },
            );
        },
    };
}
