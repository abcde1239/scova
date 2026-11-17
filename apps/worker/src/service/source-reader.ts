import {
    ConnectorError,
    normalizeUrl,
    type CallContext,
    type PageReader,
    type ReadPage,
} from '@scova/connectors';

/** Reuse the run's immutable API body; missing text uses the selected reader adapter. */
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
    if (!providerPage.text.trim() || providerPage.truncated) return reader.read(url, context);
    await context.beforeAttempt?.('read');
    if (context.signal?.aborted) throw new ConnectorError('aborted', '网页读取已停止');
    return { ...providerPage, originalUrl: url };
}
