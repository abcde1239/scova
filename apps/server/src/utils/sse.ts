import type { SseMessage } from '@scova/models';

export interface SsePolicy {
    pollIntervalMs: number;
    heartbeatMs: number;
    slowClientMs: number;
    maxFrameBytes: number;
}
export const DEFAULT_SSE_POLICY: SsePolicy = {
    pollIntervalMs: 1000,
    heartbeatMs: 15_000,
    slowClientMs: 30_000,
    maxFrameBytes: 65_536,
};
const encoder = new TextEncoder();
export function encodeSse(message: SseMessage): Uint8Array {
    return encoder.encode(
        `${'eventId' in message ? `id: ${message.eventId}\n` : ''}event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`,
    );
}
