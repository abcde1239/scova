import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/vue-query';
import {
    ContractValidationError,
    type Notification,
    type ResearchNotification,
} from '@scova/models';
import {
    notificationsEndpoint,
    notificationReadEndpoint,
    type NotificationPage,
} from '@/api/notifications';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { shouldReportQueryError } from '@/api/query';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

export const notificationKinds = [
    { value: 'all', label: '全部类别' },
    { value: 'summary', label: '普通汇总' },
    { value: 'important_change', label: '重要变化' },
    { value: 'run_issue', label: '运行问题' },
    { value: 'workflow', label: '工作流通知' },
] as const;
export type NotificationFilters = {
    kind: 'all' | Notification['kind'];
    read: 'all' | 'unread' | 'read';
};
type NotificationData = InfiniteData<NotificationPage, string | undefined>;
export function readNotificationFilters(kind: unknown, read: unknown): NotificationFilters {
    return {
        kind: notificationKinds.find((option) => option.value === kind)?.value ?? 'all',
        read: read === 'unread' || read === 'read' ? read : 'all',
    };
}
export function notificationTarget(item: Notification) {
    if (item.kind === 'workflow') {
        return {
            name: 'workflow-run-detail',
            params: { runId: item.workflowRunId },
            ...(item.artifactNodeId ? { query: { artifact: item.artifactNodeId } } : {}),
        };
    }
    return item.reportId
        ? { name: 'report-detail', params: { reportId: item.reportId } }
        : { name: 'run-detail', params: { runId: item.runId } };
}
export function notificationMessage(item: Notification) {
    if (item.kind === 'workflow') return item.body;
    if (item.runStatus === 'partial') return '结果已生成，未覆盖项目见报告详情。';
    if (item.runStatus === 'failed') return '本次执行失败，未完成查阅，不能据此判断资料是否变化。';
    if (item.runStatus === 'canceled') return '本次执行已取消，不能据此判断查阅结论。';
    if (item.kind === 'important_change') return '本次报告包含已确认的重要变化，请阅读报告与引用。';
    if (item.kind === 'summary') return '本次查阅已交付报告，请阅读汇总与引用。';
    return '本次执行存在运行问题，请查看执行状态与限制。';
}
export function notificationLabel(item: Notification) {
    if (item.kind === 'workflow') return item.title || '工作流通知';
    // Status must never make partial or failed research look like a confirmed important change.
    return item.runStatus === 'partial' ||
        item.runStatus === 'failed' ||
        item.runStatus === 'canceled'
        ? '运行问题'
        : notificationKinds.find((entry) => entry.value === item.kind)!.label;
}
export const notificationStatus: Record<ResearchNotification['runStatus'], string> = {
    queued: '排队中',
    running: '正在执行',
    recovering: '正在恢复',
    cancel_requested: '已请求取消',
    succeeded: '执行完成',
    partial: '有范围说明',
    failed: '执行失败',
    canceled: '已取消',
};
export function notificationsError(cause: unknown) {
    const error = toApiError(cause);
    const invalid = error.kind === 'protocol' || error.kind === 'validation';
    return {
        hidden: invalid || [401, 403, 404].includes(error.status ?? 0),
        restart:
            invalid ||
            error.code === 'INVALID_CURSOR' ||
            [401, 403, 404].includes(error.status ?? 0),
        message:
            error.status === 403
                ? '当前账号无权读取通知。'
                : error.status === 404
                  ? '通知当前不可用，请重新读取。'
                  : invalid
                    ? '通知内容校验未通过，请重新读取。'
                    : error.code === 'INVALID_CURSOR'
                      ? '分页位置已失效，请刷新通知重新读取。'
                      : '通知暂时无法读取，请检查连接后重试。',
    };
}
export function visibleNotifications(pages: NotificationPage[]) {
    const seen = new Set<string>();
    return pages
        .flatMap((page) => page.items)
        .filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
}
function sameNotification(item: Notification, updated: Notification) {
    if (item.id !== updated.id || item.kind !== updated.kind) return false;
    if (item.kind === 'workflow') {
        return (
            updated.kind === 'workflow' &&
            item.workflowRunId === updated.workflowRunId &&
            item.nodeId === updated.nodeId &&
            item.artifactNodeId === updated.artifactNodeId
        );
    }
    return (
        updated.kind !== 'workflow' &&
        item.runId === updated.runId &&
        item.taskId === updated.taskId &&
        item.reportId === updated.reportId
    );
}
function matches(item: Notification, kind: unknown, read: unknown) {
    return (
        (kind === 'all' || item.kind === kind) &&
        (read === 'all' || (read === 'unread' ? item.readAt === null : item.readAt !== null))
    );
}
/** Worker publishes delivery + terminal status atomically; summary/change also require a report. */
export function assertNotification(item: Notification) {
    if (item.kind === 'workflow') return;
    const valid =
        item.kind === 'run_issue'
            ? item.runStatus === 'partial' || item.runStatus === 'failed'
            : item.runStatus === 'succeeded' && item.reportId !== null;
    if (!valid)
        throw new ContractValidationError([
            { path: '/kind', message: '通知分类与执行状态或报告关联不一致' },
        ]);
}

export function useNotifications(
    selected: MaybeRefOrGetter<NotificationFilters>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const filters = computed(() => toValue(selected));
    const pendingId = ref<string>();
    const actionError = ref('');
    const announcement = ref('');
    let controller = new AbortController();
    let viewRevision = 0;
    const query = useInfiniteQuery(
        computed(() => {
            const scope = lifecycle.capture();
            const { kind, read } = filters.value;
            return {
                queryKey: scope.queryKey(['notifications', kind, read]),
                enabled: scope.accountId !== null,
                initialPageParam: undefined as string | undefined,
                async queryFn({
                    pageParam,
                    signal,
                }: {
                    pageParam: string | undefined;
                    signal: AbortSignal;
                }) {
                    const response = await scope.request(
                        notificationsEndpoint,
                        {
                            query: {
                                limit: 20,
                                ...(kind === 'all' ? {} : { kind }),
                                ...(read === 'all' ? {} : { unread: read === 'unread' }),
                                ...(pageParam === undefined ? {} : { cursor: pageParam }),
                            },
                        },
                        { signal },
                    );
                    response.data.items.forEach(assertNotification);
                    if (pageParam !== undefined && response.data.nextCursor === pageParam)
                        throw new ContractValidationError([
                            { path: '/nextCursor', message: '通知分页位置未前进' },
                        ]);
                    return response.data;
                },
                getNextPageParam(
                    page: NotificationPage,
                    _pages: NotificationPage[],
                    _previous: string | undefined,
                    params: (string | undefined)[],
                ) {
                    return page.nextCursor && !params.includes(page.nextCursor)
                        ? page.nextCursor
                        : undefined;
                },
            };
        }),
        lifecycle.queryClient,
    );
    watch(
        () => lifecycle.session.epoch,
        () => {
            viewRevision++;
            controller.abort();
            controller = new AbortController();
            pendingId.value = undefined;
            actionError.value = '';
            announcement.value = '';
        },
        { flush: 'sync' },
    );
    watch(
        () => `${filters.value.kind}:${filters.value.read}`,
        () => {
            viewRevision++;
            actionError.value = '';
            announcement.value = '';
        },
        { flush: 'sync' },
    );
    onScopeDispose(() => {
        viewRevision++;
        controller.abort();
        if (pendingId.value)
            void lifecycle.queryClient.invalidateQueries({
                queryKey: lifecycle.capture().queryKey(['notifications']),
                refetchType: 'none',
            });
    });
    const error = computed(() => notificationsError(query.error.value));
    const items = computed(() =>
        lifecycle.session.user && !(query.isError.value && error.value.hidden)
            ? visibleNotifications(query.data.value?.pages ?? [])
            : [],
    );
    async function setRead(item: Notification, read: boolean) {
        if (pendingId.value || !lifecycle.session.user) return false;
        const scope = lifecycle.capture();
        const signal = controller.signal;
        const revision = viewRevision;
        const prefix = scope.queryKey(['notifications']);
        pendingId.value = item.id;
        actionError.value = '';
        announcement.value = '';
        try {
            const response = await scope.request(
                notificationReadEndpoint,
                {
                    params: { notificationId: item.id },
                    body: { read },
                },
                { signal },
            );
            assertNotification(response.data);
            if (!sameNotification(item, response.data) || (response.data.readAt !== null) !== read)
                throw new ContractValidationError([
                    { path: '/id', message: '通知已读响应与操作不一致' },
                ]);
            if (!scope.isCurrent() || signal.aborted) return false;
            await lifecycle.queryClient.cancelQueries({ queryKey: prefix });
            if (!scope.isCurrent() || signal.aborted) return false;
            for (const [key, data] of lifecycle.queryClient.getQueriesData<NotificationData>({
                queryKey: prefix,
            })) {
                if (!data) continue;
                lifecycle.queryClient.setQueryData<NotificationData>(key, {
                    ...data,
                    pages: data.pages.map((page) => ({
                        ...page,
                        items: page.items
                            .map((entry) => (entry.id === item.id ? response.data : entry))
                            .filter((entry) => matches(entry, key[4], key[5])),
                    })),
                });
            }
            if (viewRevision === revision)
                announcement.value = read ? '通知已标记为已读。' : '通知已恢复为未读。';
            await lifecycle.queryClient.invalidateQueries({ queryKey: prefix });
            return scope.isCurrent() && !signal.aborted && viewRevision === revision;
        } catch (cause) {
            if (scope.isCurrent())
                void lifecycle.queryClient.invalidateQueries({
                    queryKey: prefix,
                    refetchType: 'none',
                });
            if (
                scope.isCurrent() &&
                !signal.aborted &&
                viewRevision === revision &&
                shouldReportQueryError(cause)
            )
                actionError.value = '通知已读状态未能确认，保留原显示状态；请重新读取核对或重试。';
            return false;
        } finally {
            if (controller.signal === signal) pendingId.value = undefined;
        }
    }
    return { query, items, error, pendingId, actionError, announcement, setRead };
}
