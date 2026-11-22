import { createHash } from 'node:crypto';
import type { ToolCall } from '@scova/db';
import { RunExecutionError } from '@scova/shared/execution/runs';

export const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const invalid = (): never => {
    throw new RunExecutionError('INVALID_DELIVERY_EVIDENCE');
};
export function output(call: ToolCall): unknown {
    const ref = call.outputRef as { schemaVersion?: number; result?: unknown } | null;
    if (ref?.schemaVersion !== 1 || !ref.result) return invalid();
    return ref.result;
}
