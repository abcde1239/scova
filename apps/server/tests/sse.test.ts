import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createStreamRegistry } from '../src/app/streams.ts';
import type { EventPage } from '../src/repo/run-events.ts';
import { parseEventCursor } from '../src/service/run-events.ts';
import { createSseBody } from '../src/http/sse.ts';
import { DEFAULT_SSE_POLICY } from '../src/utils/sse.ts';

const runId = randomUUID();
function page(status: EventPage['run']['status'] = 'queued', events = true): EventPage {
    const now = new Date();
    return {
        run: {
            conversationContextJson: null,
            id: runId,
            userId: randomUUID(),
            taskId: randomUUID(),
            taskVersionId: randomUUID(),
            parentRunId: null,
            baselineRunId: null,
            mode: 'demo',
            status,
            outcome: null,
            trigger: 'manual',
            budgetJson: {
                maxSearches: 1,
                maxPages: 1,
                maxDurationSeconds: 10,
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
            },
            usageJson: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: true },
            coverageJson: null,
            queuedAt: now,
            startedAt: null,
            finishedAt: null,
            failureCode: null,
            comparisonScopeHash: 'a'.repeat(64),
            occurrenceId: null,
            leaseOwner: null,
            leaseEpoch: 0,
            leaseExpiresAt: null,
            recoveryCount: 0,
            cancelRequestedAt: null,
            deadlineAt: null,
            feedbackSnapshotJson: [],
            followupConfigJson: null,
            checkpointRef: null,
        },
        events: events
            ? [
                  {
                      id: randomUUID(),
                      userId: randomUUID(),
                      runId,
                      seq: 1,
                      schemaVersion: 1,
                      occurredAt: now,
                      type: 'run.queued',
                      payload: { status: 'queued', taskVersionId: randomUUID() },
                  },
              ]
            : [],
        cursor: events ? 0 : 1,
        latest: 1,
        reset: false,
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function stream(first = page(), next = vi.fn(async () => page('queued', false))) {
    const registry = createStreamRegistry();
    const controller = new AbortController();
    const body = createSseBody({
        first,
        next,
        registry,
        signal: controller.signal,
        expiresAt: new Date(Date.now() + 3_600_000),
        clock: () => new Date(),
        policy: DEFAULT_SSE_POLICY,
    });
    return { body, registry, controller, next, reader: body.getReader() };
}
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);

describe('SSE 游标与有界连接生命周期', () => {
    beforeEach(() =>
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }),
    );
    afterEach(() => vi.useRealTimers());

    it('严格解析安全整数与 UUID，不默许空值、小数、指数、符号和溢出', () => {
        expect(parseEventCursor(null, null)).toEqual({ after: undefined, lastEventId: undefined });
        expect(parseEventCursor('0', runId)).toEqual({ after: 0, lastEventId: runId });
        for (const value of ['', ' ', '1.5', '1e2', '-1', '+1', '01', '9007199254740992'])
            expect(() => parseEventCursor(value, null)).toThrow('非负安全整数');
        for (const value of ['', 'bad', '1\nid: forged'])
            expect(() => parseEventCursor(null, value)).toThrow('Last-Event-ID');
    });

    it('逐帧输出 eventId，客户端不请求下一帧时不预取或查询', async () => {
        const s = stream();
        expect(s.next).not.toHaveBeenCalled();
        expect(decode((await s.reader.read()).value)).toContain('event: run.queued\ndata:');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(s.next).not.toHaveBeenCalled();
        await s.reader.cancel();
        await s.registry.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('无新事件15秒后产生注释心跳，不带id或业务data', async () => {
        const s = stream();
        await s.reader.read();
        const heartbeat = s.reader.read();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(decode((await heartbeat).value)).toBe(': heartbeat\n\n');
        await s.reader.cancel();
        await s.registry.stop();
    });

    it('保留范围reset没有id/seq，发送一帧后关闭，不再查询', async () => {
        const first = page();
        first.reset = true;
        const s = stream(first);
        const frame = decode((await s.reader.read()).value);
        expect(frame).toContain('event: stream.reset');
        expect(frame).not.toMatch(/^id:/m);
        expect(frame).not.toContain('"seq":');
        expect(frame).toContain('"resumeAfter":1');
        expect((await s.reader.read()).done).toBe(true);
        expect(s.next).not.toHaveBeenCalled();
        await s.registry.stop();
    });

    it('终态发送完同一快照的全部事件再关闭', async () => {
        const s = stream(page('failed'));
        expect((await s.reader.read()).done).toBe(false);
        expect((await s.reader.read()).done).toBe(true);
        expect(s.next).not.toHaveBeenCalled();
        await s.registry.stop();
    });

    it('慢客户端超时断开且取消所有计时器', async () => {
        const s = stream();
        await s.reader.read();
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(s.reader.read()).rejects.toThrow('事件连接已结束');
        await s.registry.stop();
        expect(s.next).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('request abort停止待轮询并清理timer，不启动后续查询', async () => {
        const s = stream();
        await s.reader.read();
        const reading = s.reader.read();
        const rejected = expect(reading).rejects.toThrow('事件连接已结束');
        s.controller.abort();
        await rejected;
        await s.registry.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(s.next).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('registry关闭先abort并等待在途DB查询结束，拒绝新连接', async () => {
        const waiting = deferred<EventPage>();
        const s = stream(
            page(),
            vi.fn(() => waiting.promise),
        );
        await s.reader.read();
        const reading = s.reader.read();
        const rejected = expect(reading).rejects.toThrow('事件连接已结束');
        await vi.advanceTimersByTimeAsync(1000);
        expect(s.next).toHaveBeenCalledTimes(1);
        let drained = false;
        const closing = s.registry.stop().then(() => {
            drained = true;
        });
        await rejected;
        expect(drained).toBe(false);
        expect(() => s.registry.register(() => {}, Promise.resolve())).toThrow('服务正在关闭');
        waiting.resolve(page('queued', false));
        await closing;
        await s.registry.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('会话到期独立中止空闲连接，过大帧不进入输出队列', async () => {
        const first = page();
        const registry = createStreamRegistry();
        const body = createSseBody({
            first,
            next: async () => page('queued', false),
            registry,
            signal: new AbortController().signal,
            expiresAt: new Date(Date.now() + 500),
            clock: () => new Date(),
            policy: DEFAULT_SSE_POLICY,
        });
        const reader = body.getReader();
        await reader.read();
        await vi.advanceTimersByTimeAsync(500);
        await expect(reader.read()).rejects.toThrow('事件连接已结束');
        await registry.stop();
        const second = createStreamRegistry();
        const huge = createSseBody({
            first,
            next: async () => page('queued', false),
            registry: second,
            signal: new AbortController().signal,
            expiresAt: new Date(Date.now() + 60_000),
            clock: () => new Date(),
            policy: { ...DEFAULT_SSE_POLICY, maxFrameBytes: 10 },
        }).getReader();
        await expect(huge.read()).rejects.toThrow('事件连接已结束');
        await second.stop();
    });
});
