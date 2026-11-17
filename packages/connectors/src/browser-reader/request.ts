import { PAGE_BYTES, htmlType } from './limits.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { type SafeHttpClient, type HttpResponse } from '../http.ts';
import { readDiagnostics } from '../read-diagnostics.ts';
import { ConnectorError, type CallContext } from '../types.ts';

export async function requestMainDocument(
    url: string,
    http: SafeHttpClient,
    context: CallContext,
    signal: AbortSignal,
    deadlineAt: number,
    diagnostics: ReturnType<typeof readDiagnostics>,
    check: () => void,
    onCallbackFailure: (error: unknown) => void,
) {
    const requestMain = async (previousFailure?: ConnectorError) => {
        try {
            await diagnostics.stage('attempt', async () =>
                context.beforeAttempt?.('read', previousFailure),
            );
        } catch (error) {
            onCallbackFailure(error);
            throw error;
        }
        check();
        const response = await diagnostics.stage('http', () =>
            http.request(url, {
                signal,
                timeoutMs: Math.max(1, Math.ceil(deadlineAt - performance.now())),
                onReadDiagnostic: diagnostics.relay,
                maxBytes: PAGE_BYTES,
                maxRedirects: 3,
                responseEncoding: 'web-text',
            }),
        );
        if (response.status < 200 || response.status >= 300)
            throw new ConnectorError(
                'http',
                '网页采集失败',
                response.status >= 500,
                response.status,
            );
        if (!htmlType(response.headers['content-type'] ?? ''))
            throw new ConnectorError('invalid_response', '网页不是 HTML 正文');
        return response;
    };
    let main: HttpResponse;
    try {
        main = await requestMain();
    } catch (error) {
        if (
            !(error instanceof ConnectorError) ||
            !error.retryable ||
            !(
                error.code === 'network' ||
                error.code === 'timeout' ||
                (error.code === 'http' && (error.status ?? 0) >= 500)
            )
        )
            throw error;
        await delay(200, undefined, { signal });
        main = await requestMain(error);
    }

    return main;
}
