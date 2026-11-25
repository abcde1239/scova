import { describe, expect, it } from 'vite-plus/test';
import {
    decodeExecutionValue,
    encodeExecutionValue,
    readExecutionBody,
} from '@scova/execution/wire';

describe('execution wire values', () => {
    it('round trips checkpoint values without interpreting user objects as wire tags', () => {
        const value = {
            date: new Date('2026-11-23T00:00:00Z'),
            bytes: new Uint8Array([0, 128, 255]),
            missing: undefined,
            items: [null, false, 12, { t: 'date', v: 'user text' }],
        };
        expect(
            decodeExecutionValue(JSON.parse(JSON.stringify(encodeExecutionValue(value)))),
        ).toEqual(value);
    });

    it('rejects duplicate keys and malformed bytes', () => {
        expect(() =>
            decodeExecutionValue({
                t: 'object',
                v: [
                    ['x', 1],
                    ['x', 2],
                ],
            }),
        ).toThrow('INVALID_EXECUTION_PAYLOAD');
        expect(() => decodeExecutionValue({ t: 'bytes', v: 'invalid!' })).toThrow(
            'INVALID_EXECUTION_PAYLOAD',
        );
    });

    it('cancels an oversized body and releases the stream lock', async () => {
        let canceled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(9));
            },
            cancel() {
                canceled = true;
            },
        });
        await expect(readExecutionBody(body, 8)).rejects.toThrow('INVALID_EXECUTION_PAYLOAD');
        expect(canceled).toBe(true);
        expect(body.locked).toBe(false);
    });
});
