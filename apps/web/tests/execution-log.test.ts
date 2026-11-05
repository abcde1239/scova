import { describe, expect, it } from 'vite-plus/test';
import type { RunEvent } from '@scova/models';
import { appendExecutionLog, emptyExecutionLog } from '@/utils/execution-log';

const common = {
    schemaVersion: 1 as const,
    eventId: '00000000-0000-4000-8000-000000000001',
    runId: '00000000-0000-4000-8000-000000000002',
    occurredAt: '2026-11-04T00:00:00Z',
};
const start = (seq: number): RunEvent => ({
    ...common,
    seq,
    type: 'step.started',
    payload: { step: 'read' },
});
describe('执行日志安全投影', () => {
    it('按序去重，保留阶段与耗时；节点结束不抹掉工具失败', () => {
        let state = appendExecutionLog(emptyExecutionLog(), start(1));
        state = appendExecutionLog(state, {
            ...common,
            seq: 2,
            type: 'tool.failed',
            payload: {
                toolCallId: common.eventId,
                tool: 'read',
                code: 'TOOL_UNSAFE_URL',
                message: 'DO_NOT_RENDER sk-secret prompt',
                retryable: false,
            },
        });
        state = appendExecutionLog(state, {
            ...common,
            seq: 3,
            type: 'step.completed',
            payload: { step: 'read', durationMs: 125 },
        });
        expect(state.steps.read).toEqual({
            started: 1,
            completed: 1,
            failures: 1,
            durationMs: 125,
        });
        expect(state.entries[1]).toMatchObject({
            step: 'read',
            level: 'error',
            code: 'TOOL_UNSAFE_URL',
        });
        expect(JSON.stringify(state)).not.toMatch(/DO_NOT_RENDER|secret|prompt/);
        expect(appendExecutionLog(state, start(2))).toBe(state);
    });
    it('未知code/异常/摘要均不进入日志，恶意对象属性名不命中白名单', () => {
        for (const code of ['sk-secret', '__proto__', 'constructor']) {
            const state = appendExecutionLog(emptyExecutionLog(), {
                ...common,
                seq: 1,
                type: 'tool.failed',
                payload: {
                    toolCallId: common.eventId,
                    tool: 'model',
                    code,
                    message: 'sk-secret',
                    retryable: true,
                },
            });
            expect(state.entries[0]?.code).toBeUndefined();
            expect(state.entries[0]?.text).toContain('未取得可公开');
        }
        const state = appendExecutionLog(emptyExecutionLog(), {
            ...common,
            seq: 1,
            type: 'tool.started',
            payload: { toolCallId: common.eventId, tool: 'read', summary: 'sk-secret raw text' },
        });
        expect(JSON.stringify(state)).not.toContain('sk-secret');
    });
    it('最多保留500行，阶段累计状态不会因裁剪丢失，重置标记明确', () => {
        let state = emptyExecutionLog();
        for (let seq = 1; seq <= 510; seq++) state = appendExecutionLog(state, start(seq));
        expect(state.entries).toHaveLength(500);
        expect(state.entries[0]?.seq).toBe(11);
        expect(state.omitted).toBe(10);
        expect(state.steps.read?.started).toBe(510);
        expect(emptyExecutionLog(true)).toMatchObject({ reset: true, entries: [], steps: {} });
    });
});
