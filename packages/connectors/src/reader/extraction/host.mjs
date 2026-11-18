// Private, single-use Node/vpx host. stdout is reserved for one result only.
import { createInterface } from 'node:readline';
import { extractPage } from './extract.ts';
import { ConnectorError } from '../../types.ts';

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    try {
        const input = JSON.parse(line);
        const page = extractPage(
            input.originalUrl,
            input.response,
            input.maxText,
            input.extractionVersion,
            input.normalizedEncoding,
        );
        process.stdout.write(JSON.stringify({ ok: true, page }));
    } catch (error) {
        process.stdout.write(
            JSON.stringify({
                ok: false,
                error: {
                    code: error instanceof ConnectorError ? error.code : 'extraction_failed',
                    message: error instanceof ConnectorError ? error.message : '网页正文提取失败',
                    retryable: error instanceof ConnectorError && error.retryable,
                    status: error instanceof ConnectorError ? error.status : undefined,
                },
            }),
        );
    }
    break;
}
lines.close();
process.stdin.destroy();
