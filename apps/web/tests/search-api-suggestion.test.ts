import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope } from 'vue';
import type { RunEvent } from '@scova/models';
import { useSearchApiSuggestion, SLOW_SEARCH_MS } from '@/composable/useSearchApiSuggestion';

const notification = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('naive-ui', () => ({ useNotification: () => notification }));
vi.mock('@/component/common/AppIcon.vue', () => ({ default: {} }));
const scopes: ReturnType<typeof effectScope>[] = [];
const common = { schemaVersion: 1 as const, eventId: 'event', runId: 'run', seq: 1 };
const start = (provider?: 'searxng' | 'api', age = 0): RunEvent => ({
    ...common,
    occurredAt: new Date(Date.now() - age).toISOString(),
    type: 'tool.started',
    payload: { toolCallId: 'call', tool: 'search', summary: '搜索', searchProvider: provider },
});
function setup() {
    const scope = effectScope();
    scopes.push(scope);
    return { scope, monitor: scope.run(useSearchApiSuggestion)! };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T02:00:00Z'));
});
afterEach(() => {
    scopes.splice(0).forEach((scope) => scope.stop());
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('可选 Search API 提示', () => {
    it('内置搜索等待15秒提示一次，重复事件及后续失败不会重复提示', () => {
        const { monitor } = setup();
        monitor.onEvent(start('searxng'));
        monitor.onEvent(start('searxng'));
        vi.advanceTimersByTime(SLOW_SEARCH_MS - 1);
        expect(notification.info).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(notification.info).toHaveBeenCalledTimes(1);
        const options = notification.info.mock.calls[0]![0];
        expect(options.title().children).toBe('内置搜索等待较久');
        expect(options.closable).toBe(true);
        expect(options.action().props.to).toEqual({
            name: 'agent-settings',
            hash: '#search-configuration-heading',
        });
        monitor.onEvent({
            ...common,
            occurredAt: new Date().toISOString(),
            type: 'tool.failed',
            payload: {
                toolCallId: 'call',
                tool: 'search',
                code: 'TOOL_TIMEOUT',
                message: 'ignored',
                retryable: true,
                severity: 'warning',
            },
        });
        expect(notification.info).toHaveBeenCalledTimes(1);
    });
    it.each(['warning', 'error'] as const)('内置搜索%s触发提示，短时成功不提示', (severity) => {
        const { monitor } = setup();
        monitor.onEvent(start('searxng'));
        monitor.onEvent({
            ...common,
            occurredAt: new Date().toISOString(),
            type: 'tool.failed',
            payload: {
                toolCallId: 'call',
                tool: 'search',
                code: 'TOOL_HTTP_ERROR',
                message: 'ignored',
                retryable: false,
                severity,
            },
        });
        expect(notification.info).toHaveBeenCalledTimes(1);
    });
    it('快速完成、API、历史事件、未知服务及非搜索失败不会推荐切换', () => {
        const { monitor } = setup();
        monitor.onEvent(start('searxng'));
        monitor.onEvent({
            ...common,
            occurredAt: new Date().toISOString(),
            type: 'tool.completed',
            payload: {
                toolCallId: 'call',
                tool: 'search',
                durationMs: 100,
                usage: { searches: 1, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
            },
        });
        monitor.onEvent(start('api'));
        monitor.onEvent(start());
        monitor.onEvent(start('searxng', 60_000));
        monitor.onEvent({
            ...start('searxng'),
            type: 'tool.started',
            payload: { toolCallId: 'read', tool: 'read', summary: '读取' },
        });
        vi.advanceTimersByTime(SLOW_SEARCH_MS * 2);
        expect(notification.info).not.toHaveBeenCalled();
    });
    it('终态、切换执行和卸载清理等待计时器', () => {
        const { monitor, scope } = setup();
        monitor.onEvent(start('searxng'));
        monitor.reset();
        vi.advanceTimersByTime(SLOW_SEARCH_MS);
        monitor.onEvent(start('searxng'));
        monitor.onEvent({
            ...common,
            occurredAt: new Date().toISOString(),
            type: 'run.failed',
            payload: { status: 'failed', code: 'NO_EVIDENCE', message: 'ignored' },
        });
        vi.advanceTimersByTime(SLOW_SEARCH_MS);
        monitor.onEvent(start('searxng'));
        scope.stop();
        vi.advanceTimersByTime(SLOW_SEARCH_MS);
        expect(notification.info).not.toHaveBeenCalled();
    });
});
