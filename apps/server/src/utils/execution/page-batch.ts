import { AgentPersistenceError } from '@scova/execution/agent';
import { executionPageBatchLimit } from '@scova/execution/protocol';
import { encodeExecutionValue, executionBodyLimit } from '@scova/execution/wire';

export class ExecutionPageBatchResponse {
    constructor(readonly body: Uint8Array<ArrayBuffer>) {}
}

// This is the ordinary tagged execution envelope. Encode each page once for both sizing and sending.
const prefix = Buffer.from('{"result":{"t":"object","v":[["pages",{"t":"array","v":[');
const separator = Buffer.from(']}],["next",');
const suffix = Buffer.from(']]}}');
const comma = Buffer.from(',');
const end = Buffer.from('null');
const envelopeBytes = prefix.length + separator.length + suffix.length;

export async function collectPageBatch<Page, Cursor>(
    entries: AsyncIterable<{ page: Page; cursor: Cursor }>,
): Promise<ExecutionPageBatchResponse> {
    const chunks = [prefix];
    let pageCount = 0;
    let bytes = envelopeBytes;
    let next = end;
    function response(cursor: Buffer) {
        const body = new Uint8Array(bytes + cursor.length);
        let offset = 0;
        for (const chunk of [...chunks, separator, cursor, suffix]) {
            body.set(chunk, offset);
            offset += chunk.length;
        }
        return new ExecutionPageBatchResponse(body);
    }
    for await (const { page, cursor } of entries) {
        if (pageCount === executionPageBatchLimit) return response(next);
        const serialized = Buffer.from(JSON.stringify(encodeExecutionValue(page)));
        const nextCursor = Buffer.from(JSON.stringify(encodeExecutionValue(cursor)));
        const needed = serialized.length + (pageCount ? 1 : 0);
        if (bytes + needed + Math.max(end.length, nextCursor.length) > executionBodyLimit) {
            if (!pageCount) throw new AgentPersistenceError('INVALID_TOOL_RESULT');
            return response(next);
        }
        if (pageCount) chunks.push(comma);
        chunks.push(serialized);
        pageCount++;
        bytes += needed;
        next = nextCursor;
    }
    return response(end);
}
