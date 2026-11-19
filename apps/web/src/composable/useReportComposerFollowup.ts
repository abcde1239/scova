import {
    computed,
    onScopeDispose,
    ref,
    shallowRef,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { OutputFormat, Report, ReportFollowupInput } from '@scova/models';
import { toApiError } from '@/api/errors';
import { followupParent, followupRun, invalidFollowup } from '@/api/followup';
import { requestReportFollowupEndpoint } from '@/api/report-questions';
import { runQueryOptions } from '@/api/runs';
import { searchConfigurationEndpoint } from '@/api/search-configuration';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import { validateQuestionDetail } from '@/utils/report/questions';

export function useReportComposerFollowup(
    reportId: () => string,
    report: MaybeRefOrGetter<Report | undefined>,
    afterQuestionId: () => string | null,
    onSaved: (id: string) => void,
    refreshConversation: () => void,
) {
    const lifecycle = useSessionLifecycle();
    const opened = ref(false);
    const pending = ref(false);
    const message = ref('');
    const blocked = ref(false);
    const draft = shallowRef<{ question: string; afterQuestionId: string | null }>();
    const attempt = shallowRef<{
        reportId: string;
        key: string;
        body: ReportFollowupInput;
        parent: Parameters<typeof followupRun>[1];
    }>();
    const searchMode = ref<'' | 'searxng' | 'api'>('');
    const formats = ref<OutputFormat[]>([]);
    const rejectedPlan = ref(false);
    let controller = new AbortController();
    const parentQuery = useQuery(
        computed(() => {
            const current = toValue(report);
            const options = current
                ? runQueryOptions(lifecycle, current.runId)
                : {
                      queryKey: lifecycle
                          .capture()
                          .queryKey(['composer-followup-parent', reportId()]),
                      queryFn: async () => invalidFollowup('报告当前不可读取'),
                  };
            return {
                ...options,
                enabled: opened.value && !!lifecycle.session.user && !!current,
            };
        }),
        lifecycle.queryClient,
    );
    const settings = useQuery(
        computed(() => ({
            ...lifecycle.queryOptions(searchConfigurationEndpoint, {}, ['search-configuration']),
            enabled: opened.value && !!lifecycle.session.user && !!toValue(report),
            staleTime: 0,
        })),
        lifecycle.queryClient,
    );
    const parent = computed(() => {
        const current = toValue(report);
        const response = parentQuery.data.value;
        if (!current || !response || response.status !== 200 || parentQuery.isError.value)
            return undefined;
        try {
            return followupParent(response.data, current);
        } catch {
            return undefined;
        }
    });
    const configuration = computed(() =>
        settings.isSuccess.value &&
        !settings.isFetching.value &&
        settings.data.value?.data.storageReady
            ? settings.data.value.data.configuration
            : undefined,
    );
    const configuredApi = computed(() => {
        const api = configuration.value?.api;
        return !!api && api.protocol !== 'perplexity';
    });
    watch(
        () => settings.data.value?.data.configuration?.revision,
        (revision, previous) => {
            if (!attempt.value && revision !== previous && searchMode.value === 'api')
                searchMode.value = '';
        },
    );
    const stalePlan = computed(
        () =>
            rejectedPlan.value ||
            (draft.value && draft.value.afterQuestionId !== afterQuestionId()),
    );
    const locked = computed(() => pending.value || !!attempt.value);
    const canConfirm = computed(
        () =>
            !locked.value &&
            !stalePlan.value &&
            !!draft.value &&
            !!parent.value &&
            !parentQuery.isFetching.value &&
            (searchMode.value === 'searxng' || (searchMode.value === 'api' && configuredApi.value)),
    );

    function close() {
        if (pending.value || attempt.value) return;
        opened.value = false;
        message.value = '';
    }
    function open(question: string, afterQuestionId: string | null) {
        if (opened.value || locked.value || toValue(report)?.mode !== 'live') return;
        draft.value = { question, afterQuestionId };
        formats.value = [];
        searchMode.value = '';
        message.value = '';
        blocked.value = false;
        rejectedPlan.value = false;
        opened.value = true;
    }
    async function send() {
        const saved = attempt.value;
        const current = toValue(report);
        if (!saved || !current || saved.reportId !== current.id || pending.value || blocked.value)
            return;
        const scope = lifecycle.capture();
        const signal = controller.signal;
        const isCurrent = () =>
            scope.isCurrent() && !signal.aborted && reportId() === saved.reportId;
        pending.value = true;
        message.value = '';
        try {
            const response = await scope.request(
                requestReportFollowupEndpoint,
                { params: { reportId: saved.reportId }, body: saved.body },
                { signal, idempotencyKey: saved.key },
            );
            if (!isCurrent()) return;
            const { question, run, reused } = response.data;
            if (response.status !== 202 || (!reused && run.status !== 'queued'))
                invalidFollowup('补查命令状态不一致');
            validateQuestionDetail(question, current, { question: saved.body.question });
            if (
                question.searchSelection.searchMode !== saved.body.searchMode ||
                (saved.body.searchMode === 'api' &&
                    (question.searchSelection.searchMode !== 'api' ||
                        question.searchSelection.searchConfigRevision !==
                            saved.body.searchConfigRevision))
            )
                invalidFollowup('本次执行的搜索配置与确认内容不一致');
            followupRun(run, saved.parent, question.followupRunId);
            attempt.value = undefined;
            opened.value = false;
            onSaved(question.id);
        } catch (error) {
            if (!isCurrent()) return;
            const failure = toApiError(error);
            if (failure.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
                blocked.value = true;
                message.value = '请求标识与已保存内容不一致，请结束本次请求后核对会话。';
                return;
            }
            const code = failure.status ?? 0;
            if (
                code >= 400 &&
                code < 500 &&
                code !== 408 &&
                code !== 429 &&
                failure.code !== 'IDEMPOTENCY_PENDING' &&
                !['validation', 'protocol'].includes(failure.kind)
            ) {
                attempt.value = undefined;
                message.value = failure.message;
                if (code === 409) {
                    rejectedPlan.value = true;
                    refreshConversation();
                }
                if (saved.body.searchMode === 'api') {
                    searchMode.value = '';
                    void settings.refetch();
                }
            } else {
                message.value = '执行结果尚未确认，原请求已保留。可以使用同一请求重发。';
            }
        } finally {
            if (!signal.aborted) pending.value = false;
        }
    }
    function confirm() {
        const current = toValue(report);
        const input = draft.value;
        const parentRun = parent.value;
        if (!opened.value || !canConfirm.value || !current || !input || !parentRun) return;
        const base = {
            confirm: true as const,
            ...input,
            ...(formats.value.length ? { outputFormats: [...formats.value] } : {}),
        };
        const revision = configuration.value?.revision;
        if (searchMode.value === 'api' && revision === undefined) return;
        const body: ReportFollowupInput =
            searchMode.value === 'api' && revision !== undefined
                ? { ...base, searchMode: 'api', searchConfigRevision: revision }
                : { ...base, searchMode: 'searxng' };
        attempt.value = {
            reportId: current.id,
            body,
            key: crypto.randomUUID(),
            parent: {
                parentRunId: parentRun.id,
                taskId: parentRun.taskId,
                taskVersionId: parentRun.taskVersionId,
                budget: { ...parentRun.budget },
                mode: parentRun.mode,
            },
        };
        return send();
    }
    function abandon() {
        if (pending.value) return;
        attempt.value = undefined;
        blocked.value = false;
        close();
    }
    function reset() {
        controller.abort();
        controller = new AbortController();
        pending.value = false;
        draft.value = undefined;
        abandon();
    }
    watch([() => lifecycle.session.epoch, reportId], reset, { flush: 'sync' });
    onScopeDispose(() => controller.abort());
    return {
        opened,
        pending,
        message,
        blocked,
        draft,
        attempt,
        searchMode,
        formats,
        parent,
        parentQuery,
        settings,
        configuredApi,
        locked,
        stalePlan,
        canConfirm,
        open,
        close,
        confirm,
        send,
        abandon,
    };
}
