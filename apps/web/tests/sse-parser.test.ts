import { describe, expect, it } from 'vite-plus/test';
import {
    parseContract,
    SseMessageSchema,
    SseResetControlSchema,
    type SseMessage,
} from '@scova/models';
import { createSseParser, SseParseError } from '@/api/sse-parser';

const runId = '00000000-0000-4000-8000-000000000001';
const eventId = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const instant = '2026-10-30T00:00:00Z';
const encoder = new TextEncoder();
const event = parseContract(SseMessageSchema, {
    schemaVersion: 1,
    eventId,
    runId,
    seq: 1,
    occurredAt: instant,
    type: 'run.failed',
    payload: { status: 'failed', code: 'NO_EVIDENCE', message: '暂未取得可靠资料🌙' },
});
const reset = parseContract(SseResetControlSchema, {
    schemaVersion: 1,
    type: 'stream.reset',
    runId,
    payload: {
        reason: 'cursor_expired',
        resumeAfter: 7,
        snapshot: {
            id: runId,
            taskId: otherId,
            taskVersionId: otherId,
            parentRunId: null,
            baselineRunId: null,
            mode: 'demo',
            status: 'queued',
            outcome: null,
            trigger: 'manual',
            budget: {
                maxSearches: 2,
                maxPages: 3,
                maxDurationSeconds: 60,
                maxInputTokens: 1000,
                maxOutputTokens: 500,
            },
            usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
            coverage: null,
            queuedAt: instant,
            startedAt: null,
            finishedAt: null,
            failureCode: null,
        },
    },
});

function frame(message: SseMessage, newline = '\n') {
    return (
        ('eventId' in message ? `id: ${message.eventId}${newline}` : '') +
        `event: ${message.type}${newline}data: ${JSON.stringify(message)}${newline}${newline}`
    );
}

function parseChunks(bytes: Uint8Array, cuts: number[]) {
    const parser = createSseParser({ runId });
    const messages: SseMessage[] = [];
    let offset = 0;
    for (const cut of cuts) {
        messages.push(...parser.push(bytes.slice(offset, cut)));
        offset = cut;
    }
    messages.push(...parser.push(bytes.slice(offset)), ...parser.finish());
    return messages;
}

describe('SSE 增量帧解析', () => {
    it('逐字节保留中文和emoji，CRLF跨chunk、心跳和多帧结果一致', () => {
        const bytes = encoder.encode(`: 心跳\r\n\r\n${frame(event, '\r\n')}${frame(reset)}`);
        expect(
            parseChunks(
                bytes,
                Array.from({ length: bytes.length }, (_, i) => i),
            ),
        ).toEqual([event, reset]);
    });

    it('同一字节流所有单切点和多种分片宽度结果一致', () => {
        const bytes = encoder.encode(`\uFEFF${frame(event, '\r\n')}${frame(reset, '\r')}`);
        for (let split = 0; split <= bytes.length; split++)
            expect(parseChunks(bytes, [split])).toEqual([event, reset]);
        for (const width of [1, 2, 3, 5, 7, 31, 127]) {
            const cuts = [];
            for (let offset = width; offset < bytes.length; offset += width) cuts.push(offset);
            expect(parseChunks(bytes, cuts)).toEqual([event, reset]);
        }
    });

    it('多行data连接换行，字段只移除冒号后的一个空格', () => {
        const body = JSON.stringify(event, null, 2)
            .split('\n')
            .map((line) => `data: ${line}`)
            .join('\n');
        const bytes = encoder.encode(
            `retry: 200\nx-unknown: ignored\nid:${eventId}\nevent:run.failed\n${body}\n\n`,
        );
        expect(parseChunks(bytes, [1, 5, 10])).toEqual([event]);
    });

    it('不含data的注释/未知字段块不输出，也不继承id到reset', () => {
        const bytes = encoder.encode(
            `: heartbeat\nretry: 0\nunknown\nid: ${eventId}\n\n${frame(reset)}`,
        );
        expect(parseChunks(bytes, [])).toEqual([reset]);
        expect('eventId' in parseChunks(bytes, [3])[0]!).toBe(false);
    });

    it('在空行完成前保留尾帧，finish不把EOF当分隔符', () => {
        const parser = createSseParser({ runId });
        const text = frame(event);
        expect(parser.push(encoder.encode(text.slice(0, -1)))).toEqual([]);
        expect(parser.push(encoder.encode('\n'))).toEqual([event]);
        expect(parser.finish()).toEqual([]);
        const truncated = createSseParser({ runId });
        expect(truncated.push(encoder.encode(text.slice(0, -1)))).toEqual([]);
        expect(() => truncated.finish()).toThrowError(
            expect.objectContaining({ code: 'INCOMPLETE_FRAME' }),
        );
    });

    it('空流结束，结束后不能继续写入；错误后同样不能恢复实例', () => {
        const parser = createSseParser({ runId });
        expect(parser.push(new Uint8Array())).toEqual([]);
        expect(parser.finish()).toEqual([]);
        expect(() => parser.push(encoder.encode(frame(event)))).toThrowError(
            expect.objectContaining({ code: 'PARSER_CLOSED' }),
        );
        const invalid = createSseParser({ runId });
        expect(() => invalid.push(encoder.encode('data: nope\n\n'))).toThrow(SseParseError);
        expect(() => invalid.push(encoder.encode(frame(event)))).toThrowError(
            expect.objectContaining({ code: 'PARSER_CLOSED' }),
        );
    });

    it('帧上限按原始字节含CRLF计算，按帧重置且限制无换行输入和心跳', () => {
        const bytes = encoder.encode(frame(event, '\r\n'));
        expect(createSseParser({ runId, maxFrameBytes: bytes.length }).push(bytes)).toEqual([
            event,
        ]);
        expect(() =>
            createSseParser({ runId, maxFrameBytes: bytes.length - 1 }).push(bytes),
        ).toThrowError(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }));
        expect(
            createSseParser({ runId, maxFrameBytes: bytes.length }).push(
                encoder.encode(frame(event, '\r\n').repeat(2)),
            ),
        ).toEqual([event, event]);
        for (const text of ['x'.repeat(9), ': heartbeats long\n\n'])
            expect(() =>
                createSseParser({ runId, maxFrameBytes: 8 }).push(encoder.encode(text)),
            ).toThrowError(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }));
    });

    it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('拒绝非法帧上限 %s', (maxFrameBytes) => {
        expect(() => createSseParser({ runId, maxFrameBytes })).toThrow(RangeError);
    });

    it.each([
        { ...event, schemaVersion: 2 },
        { ...event, runId: otherId },
        { ...event, seq: 0 },
        { ...event, seq: 1.5 },
        { ...event, seq: Number.MAX_SAFE_INTEGER + 1 },
        { ...event, eventId: 'bad' },
        { ...event, payload: {} },
    ])('拒绝错误版本、runId与事件schema %j', (input) => {
        const text = `id: ${eventId}\nevent: run.failed\ndata: ${JSON.stringify(input)}\n\n`;
        expect(() => createSseParser({ runId }).push(encoder.encode(text))).toThrow(SseParseError);
    });

    it.each([
        `event: run.failed\ndata: ${JSON.stringify(event)}\n\n`,
        `id: ${otherId}\nevent: run.failed\ndata: ${JSON.stringify(event)}\n\n`,
        `id: ${eventId}\nevent: run.started\ndata: ${JSON.stringify(event)}\n\n`,
        `id: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`,
        `id: \0\nevent: run.failed\ndata: ${JSON.stringify(event)}\n\n`,
        `id:\nevent: stream.reset\ndata: ${JSON.stringify(reset)}\n\n`,
        `id: ${eventId}\nevent: stream.reset\ndata: ${JSON.stringify(reset)}\n\n`,
        frame({
            ...reset,
            payload: { ...reset.payload, snapshot: { ...reset.payload.snapshot, id: otherId } },
        }),
    ])('拒绝错误wire envelope与带id的reset', (text) => {
        expect(() => createSseParser({ runId }).push(encoder.encode(text))).toThrowError(
            expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
        );
    });

    it.each(['data: {\n\n', 'data:\n\n'])('畸形JSON显式失败', (text) => {
        expect(() => createSseParser({ runId }).push(encoder.encode(text))).toThrowError(
            expect.objectContaining({ code: 'INVALID_JSON' }),
        );
    });

    it('错误前已完成帧不因chunk划分丢失，错误中只包含本次调用已校验的消息', () => {
        const bytes = encoder.encode(`${frame(event)}data: nope\n\n`);
        for (let split = 0; split <= bytes.length; split++) {
            const parser = createSseParser({ runId });
            const messages: SseMessage[] = [];
            let failure: SseParseError | undefined;
            try {
                messages.push(...parser.push(bytes.slice(0, split)));
                messages.push(...parser.push(bytes.slice(split)));
            } catch (error) {
                if (!(error instanceof SseParseError)) throw error;
                failure = error;
                messages.push(...error.completedMessages);
            }
            expect(failure?.code).toBe('INVALID_JSON');
            expect(messages).toEqual([event]);
        }
    });

    it.each([
        { ...reset, eventId },
        { ...reset, seq: 1 },
        { ...reset, schemaVersion: 2 },
        { ...reset, payload: { ...reset.payload, resumeAfter: -1 } },
    ])('reset拒绝持久字段及错误schema %j', (input) => {
        expect(() =>
            createSseParser({ runId }).push(
                encoder.encode(`event: stream.reset\ndata: ${JSON.stringify(input)}\n\n`),
            ),
        ).toThrowError(expect.objectContaining({ code: 'INVALID_MESSAGE' }));
    });

    it('拒绝无效UTF8及EOF截断的UTF8，不替换成损坏字符', () => {
        expect(() =>
            createSseParser({ runId }).push(
                new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0xff, 10]),
            ),
        ).toThrowError(expect.objectContaining({ code: 'INVALID_UTF8' }));
        const parser = createSseParser({ runId });
        expect(parser.push(new Uint8Array([0xe4, 0xb8]))).toEqual([]);
        expect(() => parser.finish()).toThrowError(
            expect.objectContaining({ code: 'INVALID_UTF8' }),
        );
    });
});
