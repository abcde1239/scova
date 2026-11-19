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
import type { Report, Run, OutputFormat } from '@scova/models';
import {
    followupAttempt,
    followupParent,
    followupRun,
    invalidFollowup,
    requestFollowup,
    type FollowupAttempt,
} from '@/api/followup';
import { runQueryOptions } from '@/api/runs';
import { reportQuestionEndpoint, type ReportQuestionDetail } from '@/api/report-questions';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import { questionResponse, validateQuestionDetail } from '@/utils/report/questions';

export function useFollowup(
    reportId: MaybeRefOrGetter<string>,
    questionId: MaybeRefOrGetter<string>,
    report: MaybeRefOrGetter<Report | undefined>,
    question: MaybeRefOrGetter<ReportQuestionDetail | undefined>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
    operation: MaybeRefOrGetter<'research' | 'revise'> = 'research',
    outputFormats: MaybeRefOrGetter<OutputFormat[]> = [],
) {
    const opened = ref(false);
    const pending = ref(false);
    const attempt = shallowRef<FollowupAttempt>();
    const confirmedId = ref('');
    const message = ref('');
    const phase = ref<'idle' | 'sending' | 'uncertain' | 'blocked' | 'rejected' | 'success'>(
        'idle',
    );
    let generation = 0;
    let controller = new AbortController();
    let disposed = false;
    const available = computed(() => {
        const current = toValue(report),
            saved = toValue(question);
        if (
            !lifecycle.session.user ||
            !current ||
            !saved ||
            current.id !== toValue(reportId) ||
            saved.id !== toValue(questionId)
        )
            return false;
        try {
            validateQuestionDetail(saved, current, {
                id: toValue(questionId),
                ...(attempt.value ? { question: attempt.value.question } : {}),
            });
            const frozen = attempt.value;
            return (
                !frozen ||
                (frozen.reportId === current.id &&
                    frozen.parentRunId === current.runId &&
                    frozen.taskId === current.taskId &&
                    frozen.taskVersionId === current.taskVersionId &&
                    frozen.mode === current.mode)
            );
        } catch {
            return false;
        }
    });
    const candidateId = computed(() =>
        available.value
            ? ((toValue(operation) === 'revise'
                  ? toValue(question)?.revisionRunId
                  : toValue(question)?.followupRunId) ?? confirmedId.value)
            : '',
    );
    const parentOptions = computed(() => {
        const current = toValue(report);
        const options = current
            ? runQueryOptions(lifecycle, current.runId)
            : {
                  queryKey: lifecycle.capture().queryKey(['followup-parent', toValue(reportId)]),
                  queryFn: async () => invalidFollowup('报告当前不可读取'),
              };
        return {
            ...options,
            enabled: available.value && (opened.value || !!attempt.value || !!candidateId.value),
            staleTime: 0,
            async queryFn(context: { signal: AbortSignal }) {
                const response = await options.queryFn(context);
                if (!current || response.status !== 200) invalidFollowup('原执行当前不可读取');
                followupParent(response.data, current);
                return response;
            },
        };
    });
    const parentQuery = useQuery(parentOptions, lifecycle.queryClient);
    const parent = computed(() => {
        if (
            !available.value ||
            !parentQuery.isSuccess.value ||
            parentQuery.isFetching.value ||
            !toValue(report)
        )
            return undefined;
        try {
            return followupParent(parentQuery.data.value!.data, toValue(report)!);
        } catch {
            return undefined;
        }
    });
    const expected = (value: Run) => ({
        parentRunId: value.id,
        taskId: value.taskId,
        taskVersionId: value.taskVersionId,
        mode: value.mode,
        budget: value.budget,
    });
    const linkedOptions = computed(() => {
        const id = candidateId.value;
        const source = parent.value;
        const options = id
            ? runQueryOptions(lifecycle, id)
            : {
                  queryKey: lifecycle
                      .capture()
                      .queryKey(['followup-linked', toValue(reportId), toValue(questionId)]),
                  queryFn: async () => invalidFollowup('尚无关联执行'),
              };
        return {
            ...options,
            enabled: available.value && !!id && !!source,
            staleTime: 0,
            async queryFn(context: { signal: AbortSignal }) {
                const response = await options.queryFn(context);
                if (!source || response.status !== 200) invalidFollowup('关联执行当前不可读取');
                followupRun(response.data, attempt.value ?? expected(source), id);
                return response;
            },
        };
    });
    const linkedQuery = useQuery(linkedOptions, lifecycle.queryClient);
    const linkedRun = computed(() => {
        if (!available.value || !parent.value || !candidateId.value || !linkedQuery.isSuccess.value)
            return undefined;
        try {
            return followupRun(
                linkedQuery.data.value!.data,
                attempt.value ?? expected(parent.value),
                candidateId.value,
            );
        } catch {
            return undefined;
        }
    });
    const linkedId = computed(() =>
        available.value ? (linkedRun.value?.id ?? confirmedId.value) : '',
    );
    const protectedState = computed(
        () =>
            pending.value ||
            (!!attempt.value && ['uncertain', 'blocked', 'sending'].includes(phase.value)),
    );
    const canOpen = computed(
        () =>
            available.value &&
            toValue(report)?.mode === 'live' &&
            !!toValue(question)?.answer &&
            !attempt.value &&
            !candidateId.value &&
            !pending.value,
    );
    watch(linkedRun, (value) => {
        if (value && !pending.value && ['uncertain', 'blocked'].includes(phase.value)) {
            confirmedId.value = value.id;
            phase.value = 'success';
            message.value = '已核验保存问题的关联执行，未发送新的后续研究命令。';
        }
    });
    function abort() {
        generation++;
        controller.abort();
        controller = new AbortController();
        pending.value = false;
    }
    function reset() {
        abort();
        opened.value = false;
        attempt.value = undefined;
        confirmedId.value = '';
        phase.value = 'idle';
        message.value = '';
    }
    watch(() => `${lifecycle.session.epoch}:${toValue(reportId)}:${toValue(questionId)}`, reset, {
        flush: 'sync',
    });
    watch(
        available,
        (value) => {
            if (!value) {
                const sent = !!attempt.value && (pending.value || phase.value === 'uncertain');
                abort();
                opened.value = false;
                if (sent) {
                    phase.value = 'uncertain';
                    message.value =
                        '报告或回答暂时不可读取。原请求与标识已保留，恢复后可明确读取关联或使用同一请求重发。';
                }
            }
        },
        { flush: 'sync' },
    );
    function open() {
        if (canOpen.value) {
            opened.value = true;
            message.value = '';
        }
    }
    function close() {
        if (!pending.value) opened.value = false;
    }
    function invalidate(id: string, scope: ReturnType<SessionLifecycle['capture']>) {
        for (const key of [
            ['run', id],
            ['runs'],
            ['tasks'],
            ['report-conversation', toValue(reportId)],
        ])
            void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(key) });
        const options = lifecycle.queryOptions(
            reportQuestionEndpoint,
            { params: { reportId: toValue(reportId), questionId: toValue(questionId) } },
            ['report-questions', toValue(reportId), toValue(questionId)],
        );
        void lifecycle.queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
    }
    async function send(frozen: FollowupAttempt) {
        if (!available.value || pending.value || phase.value === 'blocked') return;
        const scope = lifecycle.capture(),
            action = ++generation,
            signal = controller.signal;
        const active = () =>
            !disposed &&
            action === generation &&
            scope.isCurrent() &&
            available.value &&
            attempt.value === frozen;
        pending.value = true;
        phase.value = 'sending';
        message.value = '';
        try {
            const response = await requestFollowup(
                scope,
                frozen,
                signal,
                toValue(operation) === 'revise'
                    ? toValue(question)?.revisionRunId
                    : toValue(question)?.followupRunId,
            );
            if (!active()) return;
            confirmedId.value = response.data.run.id;
            phase.value = 'success';
            message.value = response.data.reused
                ? '已复用这个问题的关联执行，可能已结束；请查看实际执行状态。'
                : '已创建独立后续执行并入队，原报告保留。';
            invalidate(response.data.run.id, scope);
        } catch (cause) {
            if (!active()) return;
            const error = toApiError(cause);
            if (error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
                phase.value = 'blocked';
                message.value =
                    '原请求与幂等记录不一致，已停止重发并保留原标识；可明确读取已保存关联。';
            } else if (
                !error.status ||
                error.status === 408 ||
                error.status >= 500 ||
                ['validation', 'protocol'].includes(error.kind) ||
                error.code === 'IDEMPOTENCY_PENDING'
            ) {
                phase.value = 'uncertain';
                message.value =
                    '后续执行结果尚未确认，服务端可能已经创建执行。原问题、模式、预算和请求标识已保留；请明确读取关联或使用同一请求重发。';
            } else {
                phase.value = 'rejected';
                attempt.value = undefined;
                message.value =
                    error.code === 'RUN_ALREADY_ACTIVE'
                        ? '任务已有其他活动执行，本次未创建后续研究；请先核对该任务。'
                        : error.code === 'TASK_ARCHIVED'
                          ? '任务已归档，不能为此问题创建新的后续执行。'
                          : error.code === 'TASK_VERSION_MISSING'
                            ? '原报告的配置版本不可用，不能创建后续执行。'
                            : error.code === 'FOLLOWUP_UNAVAILABLE'
                              ? '已有关联执行暂不可用，未创建第二个执行。'
                              : '后续执行命令未通过检查；请核对权限和当前状态后再确认。';
            }
        } finally {
            if (action === generation) {
                pending.value = false;
                opened.value = false;
            }
        }
    }
    async function confirm() {
        if (!opened.value || !canOpen.value || !parent.value || parentQuery.isFetching.value)
            return;
        const current = toValue(report)!,
            saved = toValue(question);
        if (!saved?.answer) return;
        attempt.value = followupAttempt(
            current,
            saved,
            parent.value,
            crypto.randomUUID(),
            toValue(operation),
            toValue(outputFormats),
        );
        return send(attempt.value);
    }
    function replay() {
        if (phase.value === 'uncertain' && attempt.value && !pending.value)
            return send(attempt.value);
    }
    async function recover() {
        if (
            !available.value ||
            !attempt.value ||
            pending.value ||
            !['uncertain', 'blocked'].includes(phase.value)
        )
            return;
        const frozen = attempt.value,
            scope = lifecycle.capture(),
            action = ++generation;
        const active = () =>
            !disposed &&
            action === generation &&
            scope.isCurrent() &&
            available.value &&
            attempt.value === frozen;
        pending.value = true;
        try {
            const response = await scope.request(
                reportQuestionEndpoint,
                { params: { reportId: frozen.reportId, questionId: frozen.questionId } },
                { signal: controller.signal },
            );
            if (!active()) return;
            questionResponse(response, toValue(report)!, {
                id: frozen.questionId,
                question: frozen.question,
            });
            const savedRunId =
                toValue(operation) === 'revise'
                    ? response.data.revisionRunId
                    : response.data.followupRunId;
            if (!savedRunId) {
                message.value =
                    phase.value === 'blocked'
                        ? '已保存问题尚未返回关联执行。原请求仍保留且重发已停止，请稍后再次读取关联。'
                        : '已保存问题尚未返回关联执行，但这不能证明原命令未成功。原请求仍保留，可使用同一请求重发。';
                return;
            }
            const id = savedRunId;
            const options = runQueryOptions(lifecycle, id);
            const run = await lifecycle.queryClient.fetchQuery({
                ...options,
                staleTime: 0,
                queryFn: async (context) => {
                    const result = await options.queryFn(context);
                    followupRun(result.data, frozen, id);
                    return result;
                },
            });
            if (!active()) return;
            followupRun(run.data, frozen, id);
            confirmedId.value = id;
            phase.value = 'success';
            message.value = '已从保存的问题恢复关联执行，未发送新的后续研究命令。';
            const questionOptions = lifecycle.queryOptions(
                reportQuestionEndpoint,
                { params: { reportId: frozen.reportId, questionId: frozen.questionId } },
                ['report-questions', frozen.reportId, frozen.questionId],
            );
            lifecycle.queryClient.setQueryData(questionOptions.queryKey, response);
            invalidate(id, scope);
        } catch {
            if (active())
                message.value =
                    '关联暂时无法核验。原请求与标识仍保留，请稍后明确读取；不会自动创建新执行。';
        } finally {
            if (action === generation) pending.value = false;
        }
    }
    onScopeDispose(() => {
        disposed = true;
        reset();
        controller.abort();
    });
    return {
        opened,
        pending,
        attempt,
        confirmedId,
        phase,
        message,
        available,
        parent,
        parentQuery,
        linkedId,
        linkedRun,
        linkedQuery,
        candidateId,
        protectedState,
        canOpen,
        open,
        close,
        confirm,
        replay,
        recover,
    };
}
