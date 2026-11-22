// Every object is represented as entries so user data cannot collide with wire tags.
export function encodeExecutionValue(value: unknown, depth = 0): unknown {
    if (depth > 80) throw new Error('INVALID_EXECUTION_PAYLOAD');
    if (value === undefined) return { t: 'undefined' };
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) return { t: 'date', v: value.toISOString() };
    if (value instanceof Uint8Array)
        return { t: 'bytes', v: Buffer.from(value).toString('base64') };
    if (Array.isArray(value))
        return { t: 'array', v: value.map((item) => encodeExecutionValue(item, depth + 1)) };
    if (
        value &&
        typeof value === 'object' &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
        return {
            t: 'object',
            v: Object.entries(value).map(([key, item]) => [
                key,
                encodeExecutionValue(item, depth + 1),
            ]),
        };
    throw new Error('INVALID_EXECUTION_PAYLOAD');
}

export function decodeExecutionValue(value: unknown, depth = 0): unknown {
    if (depth > 80) throw new Error('INVALID_EXECUTION_PAYLOAD');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('INVALID_EXECUTION_PAYLOAD');
    const { t, v } = value as { t?: string; v?: unknown };
    if (t === 'undefined') return undefined;
    if (t === 'date' && typeof v === 'string' && Number.isFinite(Date.parse(v))) return new Date(v);
    if (
        t === 'bytes' &&
        typeof v === 'string' &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)
    )
        return new Uint8Array(Buffer.from(v, 'base64'));
    if (t === 'array' && Array.isArray(v))
        return v.map((item) => decodeExecutionValue(item, depth + 1));
    if (t === 'object' && Array.isArray(v)) {
        const result: Record<string, unknown> = {};
        for (const entry of v) {
            if (
                !Array.isArray(entry) ||
                entry.length !== 2 ||
                typeof entry[0] !== 'string' ||
                Object.hasOwn(result, entry[0])
            )
                throw new Error('INVALID_EXECUTION_PAYLOAD');
            Object.defineProperty(result, entry[0], {
                value: decodeExecutionValue(entry[1], depth + 1),
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
        return result;
    }
    throw new Error('INVALID_EXECUTION_PAYLOAD');
}

export const executionBodyLimit = 8 * 1024 * 1024;
// Older approved checkpoints can contain 20 page bodies of up to one million characters each.
export const legacyCheckpointBodyLimit = 128 * 1024 * 1024;
export const executionOperationHeader = 'x-scova-execution-operation';
export function executionRequestLimit(action: string | null) {
    return action === 'checkpointPut' || action === 'checkpointWrites'
        ? legacyCheckpointBodyLimit
        : executionBodyLimit;
}

export async function readExecutionBody(
    body: ReadableStream<Uint8Array> | null,
    limit = executionBodyLimit,
): Promise<unknown> {
    if (!body) throw new Error('INVALID_EXECUTION_PAYLOAD');
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > limit) throw new Error('INVALID_EXECUTION_PAYLOAD');
            chunks.push(next.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
