import { computed, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query';
import { parseContract, UuidSchema, type Run, type RunEvent } from '@scova/models';
import { runQueryOptions } from '@/api/runs';
import { runReportsOptions } from '@/api/run-detail';
import { toApiError } from '@/api/errors';
import { useRunEvents } from '@/composables/useRunEvents';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { appendExecutionLog, emptyExecutionLog } from '@/utils/execution-log';

export const executionStates = {
    queued: ['等待执行', '已保存排队状态，等待后台开始查阅。'],
    running: ['正在查阅', '后台正在研究；可以离开此页，稍后返回查看。'],
    recovering: ['系统恢复中', '系统正在恢复上次执行，不需要手动继续。'],
    cancel_requested: ['正在取消', '取消请求已保存，等待后台停止在途工作。'],
    succeeded: ['已完成', '已完成本次查阅范围，仍须结合覆盖说明阅读结论。'],
    partial: ['部分完成', '已有部分交付，覆盖仍有缺口，不能视为完整查阅或没有变化。'],
    failed: ['执行失败', '本次未完成交付，不能将失败解释为资料没有变化。'],
    canceled: ['已取消', '执行已经停止，不能据此判断查阅结论。'],
} satisfies Record<Run['status'], [string, string]>;
const outcomes = {
    baseline: '已建立基线',
    important_change: '发现重要变化',
    new_findings: '发现新资料',
    no_important_change: '本次范围内未发现重要变化',
    inconclusive: '暂无法得出结论',
};
export function executionOutcome(run: Run) {
    if (run.status === 'succeeded' && run.outcome) return outcomes[run.outcome];
    if (run.status === 'partial') return '结果不完整';
    return undefined;
}
export function executionFailure(run: Run) {
    if (run.status !== 'failed') return undefined;
    const reasons: Record<string, string> = {
        NO_EVIDENCE: '未取得可用证据，未生成报告。',
        DEADLINE_EXCEEDED: '执行时间预算已耗尽，未完成交付。',
        AGENT_CONFIGURATION_INVALID: '研究服务配置不可用，本次未完成。',
        AGENT_DELIVERY_NOT_CONFIGURED: '报告交付服务不可用，本次未完成。',
        INVALID_DELIVERY_EVIDENCE: '交付证据校验未通过，未发布报告。',
    };
    return reasons[run.failureCode ?? ''] ?? '本次执行未完成，未取得可公开的具体失败说明。';
}
export interface ToolSummary {
    id: string;
    tool: 'search' | 'read' | 'model';
    status: 'started' | 'completed' | 'failed';
    durationMs?: number;
}
/** 只投影白名单字段；不把 summary/message/参数/原文等自由文本搬入页面。 */
export function updateTools(items: ToolSummary[], event: RunEvent): ToolSummary[] {
    if (
        event.type !== 'tool.started' &&
        event.type !== 'tool.completed' &&
        event.type !== 'tool.failed'
    )
        return items;
    const item: ToolSummary = {
        id: event.payload.toolCallId,
        tool: event.payload.tool,
        status:
            event.type === 'tool.started'
                ? 'started'
                : event.type === 'tool.completed'
                  ? 'completed'
                  : 'failed',
        ...(event.type === 'tool.completed' ? { durationMs: event.payload.durationMs } : {}),
    };
    return [...items.filter((entry) => entry.id !== item.id), item].slice(-12);
}
const fallbackId = '00000000-0000-4000-8000-000000000000';
export function useExecution(target: MaybeRefOrGetter<string>) {
    const lifecycle = useSessionLifecycle();
    const id = computed(() => {
        try {
            return parseContract(UuidSchema, toValue(target));
        } catch {
            return undefined;
        }
    });
    const tools = shallowRef<ToolSummary[]>([]);
    const log = shallowRef(emptyExecutionLog());
    const published = shallowRef<string>();
    watch(
        () => [id.value, lifecycle.session.epoch],
        () => {
            tools.value = [];
            log.value = emptyExecutionLog();
            published.value = undefined;
        },
        { flush: 'sync' },
    );
    const query = useQuery(
        computed(() => ({
            ...runQueryOptions(lifecycle, id.value ?? fallbackId),
            enabled: !!id.value && !!lifecycle.session.user,
        })),
        lifecycle.queryClient,
    );
    const run = computed(() => {
        if (!id.value || !lifecycle.session.user) return undefined;
        const error = query.error.value ? toApiError(query.error.value) : undefined;
        if (
            [401, 403, 404].includes(error?.status ?? 0) ||
            error?.kind === 'validation' ||
            error?.kind === 'protocol'
        )
            return undefined;
        const snapshot = query.data.value?.data;
        return snapshot?.id === id.value ? snapshot : undefined;
    });
    const streamId = computed(() => (run.value?.id === id.value ? id.value : undefined));
    const subscription = useRunEvents(streamId, {
        onReset() {
            log.value = emptyExecutionLog(true);
            tools.value = [];
            published.value = undefined;
        },
        onEvent(event) {
            if (event.runId !== id.value || !lifecycle.session.user) return;
            tools.value = updateTools(tools.value, event);
            log.value = appendExecutionLog(log.value, event);
            if (event.type === 'report.published' || event.type === 'run.completed')
                published.value = event.payload.reportId;
        },
    });
    const reports = useInfiniteQuery(
        computed(() => ({
            ...runReportsOptions(
                lifecycle,
                run.value?.taskId ?? fallbackId,
                id.value ?? fallbackId,
            ),
            enabled:
                !!run.value &&
                !!lifecycle.session.user &&
                ['succeeded', 'partial'].includes(run.value.status) &&
                !published.value,
        })),
        lifecycle.queryClient,
    );
    const reportId = computed(() => {
        if (!run.value || !['succeeded', 'partial'].includes(run.value.status)) return undefined;
        return (
            published.value ??
            reports.data.value?.pages
                .flatMap((page) => page.items)
                .find(
                    (report) =>
                        report.runId === id.value &&
                        report.taskVersionId === run.value?.taskVersionId &&
                        report.mode === run.value?.mode,
                )?.id
        );
    });
    return { id, run, query, subscription, tools, log, reports, reportId };
}
