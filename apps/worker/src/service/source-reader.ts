import {
    ConnectorError,
    normalizeUrl,
    type CallContext,
    type PageReader,
    type ReadPage,
} from '@scova/connectors';
import { unsupportedReadCandidate } from '@scova/agent-core';

/** A search body has unknown page coverage. Verify readable HTML at its origin;
 * retain the immutable provider excerpt only when a bounded read fails normally. */
export async function readSource(
    url: string,
    providerPage: ReadPage | undefined,
    reader: PageReader,
    context: CallContext,
): Promise<ReadPage> {
    if (context.signal?.aborted) throw new ConnectorError('aborted', '网页读取已停止');
    if (!providerPage) return reader.read(url, context);
    if (
        normalizeUrl(providerPage.originalUrl) !== normalizeUrl(url) ||
        normalizeUrl(providerPage.url) !== normalizeUrl(url)
    )
        throw new ConnectorError('configuration', '搜索正文与读取地址不匹配');
    // Reader cannot parse documents such as PDF. API extraction remains explicitly
    // search-api/* with unknown completeness; it never becomes verified HTML.
    if (unsupportedReadCandidate(url)) {
        await context.beforeAttempt?.('read');
        return { ...providerPage, originalUrl: url };
    }
    let attempts = 0;
    try {
        return await reader.read(url, {
            ...context,
            beforeAttempt: async (kind, failure) => {
                await context.beforeAttempt?.(kind, failure);
                attempts++;
            },
        });
    } catch (error) {
        if (
            context.signal?.aborted ||
            !(error instanceof ConnectorError) ||
            !['network', 'timeout', 'http', 'response_too_large', 'extraction_failed'].includes(
                error.code,
            )
        )
            throw error;
        // No new physical request or second charge for a saved excerpt. The
        // original search-api extraction identity preserves its unknown coverage.
        if (!attempts) await context.beforeAttempt?.('read');
        return { ...providerPage, originalUrl: url };
    }
}
