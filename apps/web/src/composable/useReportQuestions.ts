import {
    computed,
    nextTick,
    onScopeDispose,
    ref,
    shallowRef,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from 'vue';
import { useQuery, useInfiniteQuery } from '@tanstack/vue-query';
import type { Report, ReportConversation } from '@scova/models';
import {
    createReportQuestionEndpoint,
    reportQuestionEndpoint,
    reportConversationEndpoint,
} from '@/api/report-questions';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import {
    invalidQuestion,
    questionAttempt,
    questionReadError,
    questionResponse,
    questionRetryAt,
    questionSelection,
    questionTextError,
    validateQuestion,
    type QuestionAttempt,
} from '@/utils/report/questions';

/** Only local input/action bindings live here. Saved answers belong exclusively to Vue Query. */
export function useReportQuestions(
    reportId: MaybeRefOrGetter<string>,
    report: MaybeRefOrGetter<Report | undefined>,
    selection: MaybeRefOrGetter<unknown>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const draft = ref('');
    const attempt = shallowRef<QuestionAttempt>();
    const selectedId = ref(questionSelection(toValue(selection)).id ?? '');
    const pending = ref(false);
    const notice = ref('');
    const terminal = ref(false);
    const retryAt = ref<number>();
    const now = ref(Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let controller = new AbortController();
    let disposed = false;
    const available = computed(() => {
        const current = toValue(report);
        return !!current && current.id.toLowerCase() === toValue(reportId).toLowerCase();
    });
    const address = computed(() => questionSelection(toValue(selection)));
    const conversationOptions = computed(() =>
        lifecycle.queryOptions(
            reportConversationEndpoint,
            { params: { reportId: toValue(reportId) }, query: {} },
            ['report-conversation', toValue(reportId)],
        ),
    );
    const conversation = useInfiniteQuery(
        computed(() => ({
            ...conversationOptions.value,
            enabled: conversationOptions.value.enabled && available.value,
            initialPageParam: undefined as string | undefined,
            getNextPageParam: (page: { data: ReportConversation }) =>
                page.data.hasEarlier ? page.data.turns[0]?.id : undefined,
            async queryFn(context: { signal: AbortSignal; pageParam: string | undefined }) {
                const response = await lifecycle.capture().request(
                    reportConversationEndpoint,
                    {
                        params: { reportId: toValue(reportId) },
                        query: context.pageParam ? { beforeQuestionId: context.pageParam } : {},
                    },
                    { signal: context.signal },
                );
                const current = toValue(report);
                if (!current || response.data.reportId !== current.id)
                    invalidQuestion('会话不属于当前报告');
                const ids = new Set<string>();
                for (const turn of response.data.turns) {
                    if (turn.reportId !== current.id || ids.has(turn.id))
                        invalidQuestion('会话轮次身份重复或不匹配');
                    ids.add(turn.id);
                    if (turn.answer) validateQuestion({ ...turn, answer: turn.answer }, current);
                }
                if (response.data.artifacts?.some((artifact) => !ids.has(artifact.questionId)))
                    invalidQuestion('成果不属于当前会话轮次');
                if (
                    response.data.mergeRuns?.some((run) => !ids.has(run.questionId)) ||
                    response.data.continuations?.some((run) => !ids.has(run.questionId))
                )
                    invalidQuestion('执行不属于当前会话轮次');
                const continuations = new Set<string>();
                for (const run of response.data.continuations ?? []) {
                    const turn = response.data.turns.find((turn) => turn.id === run.questionId);
                    const root =
                        run.operation === 'research' ? turn?.followupRunId : turn?.revisionRunId;
                    const key = `${run.questionId}:${run.operation}`;
                    if (root !== run.rootRunId || continuations.has(key))
                        invalidQuestion('重试执行与原轮次关联不一致');
                    continuations.add(key);
                }
                return response;
            },
            refetchInterval: (query: {
                state: { data?: { pages: { data: ReportConversation }[] } };
            }) =>
                query.state.data?.pages.some(
                    (page) => page.data.activeRun || page.data.turns.some((turn) => !turn.answer),
                )
                    ? 3000
                    : false,
        })),
        lifecycle.queryClient,
    );
    const conversationData = computed(() => {
        const pages = conversation.data.value?.pages;
        if (!pages?.length || !available.value || !conversation.isSuccess.value) return undefined;
        const all = [...pages].reverse();
        return {
            ...pages[0]!.data,
            turns: [
                ...new Map(
                    all.flatMap((page) => page.data.turns).map((turn) => [turn.id, turn]),
                ).values(),
            ],
            artifacts: all.flatMap((page) => page.data.artifacts ?? []),
            continuations: all.flatMap((page) => page.data.continuations ?? []),
            mergeRuns: [
                ...new Map(
                    all.flatMap((page) => page.data.mergeRuns ?? []).map((run) => [run.runId, run]),
                ).values(),
            ],
        };
    });
    const turns = computed(() => {
        if (
            !available.value ||
            !conversation.isSuccess.value ||
            conversationData.value?.reportId !== toValue(reportId)
        )
            return [];
        try {
            return conversationData.value.turns.map((turn) =>
                turn.answer
                    ? validateQuestion({ ...turn, answer: turn.answer }, toValue(report)!)
                    : turn,
            );
        } catch {
            return [];
        }
    });
    const optionsFor = (id: string) =>
        lifecycle.queryOptions(
            reportQuestionEndpoint,
            { params: { reportId: toValue(reportId), questionId: id } },
            ['report-questions', toValue(reportId), id],
        );
    const options = computed(() => optionsFor(selectedId.value));
    const query = useQuery(
        computed(() => {
            const current = options.value;
            const id = selectedId.value;
            return {
                ...current,
                enabled: current.enabled && available.value && !!id && !address.value.error,
                async queryFn(context: { signal: AbortSignal }) {
                    const response = await current.queryFn(context);
                    const currentReport = toValue(report);
                    if (!available.value || !currentReport) invalidQuestion('报告当前不可读取');
                    return questionResponse(response, currentReport, { id });
                },
            };
        }),
        lifecycle.queryClient,
    );
    const answer = computed(() => {
        const current = toValue(report);
        const result = query.data.value?.data;
        if (
            !available.value ||
            !current ||
            !result ||
            !query.isSuccess.value ||
            address.value.error
        )
            return undefined;
        try {
            return validateQuestion(result, current, { id: selectedId.value });
        } catch {
            return undefined;
        }
    });
    const waiting = computed(() => retryAt.value !== undefined && now.value < retryAt.value);
    const protectedState = computed(() => pending.value || !!attempt.value || draft.value !== '');
    const canSubmit = computed(
        () =>
            !!lifecycle.session.user &&
            available.value &&
            !pending.value &&
            !attempt.value &&
            conversation.isSuccess.value &&
            !conversation.isFetching.value &&
            !turns.value.some((turn) => !turn.answer) &&
            !address.value.error &&
            !questionTextError(draft.value),
    );
    const canRecover = computed(
        () =>
            !!lifecycle.session.user &&
            available.value &&
            !pending.value &&
            !waiting.value &&
            !terminal.value &&
            (!!attempt.value || !!selectedId.value) &&
            !address.value.error,
    );
    const readError = computed(() => address.value.error ?? questionReadError(query.error.value));

    function stop() {
        generation++;
        controller.abort();
        controller = new AbortController();
        pending.value = false;
        void lifecycle.queryClient.cancelQueries({ queryKey: options.value.queryKey, exact: true });
    }
    function clearWait() {
        if (timer) clearTimeout(timer);
        timer = undefined;
        retryAt.value = undefined;
    }
    function waitUntil(time?: number) {
        clearWait();
        retryAt.value = time;
        now.value = Date.now();
        if (time !== undefined && now.value < time) {
            const tick = () => {
                now.value = Date.now();
                if (now.value < time) timer = setTimeout(tick, Math.min(1000, time - now.value));
            };
            timer = setTimeout(tick, Math.min(1000, time - now.value));
        }
    }
    function reset() {
        stop();
        clearWait();
        draft.value = '';
        attempt.value = undefined;
        terminal.value = false;
        notice.value = '';
    }
    watch(
        () => `${lifecycle.session.epoch}:${lifecycle.session.user?.id ?? ''}:${toValue(reportId)}`,
        () => {
            reset();
            selectedId.value = questionSelection(toValue(selection)).id ?? '';
        },
        { flush: 'sync' },
    );
    watch(
        () => JSON.stringify(toValue(selection)),
        () => {
            const id = questionSelection(toValue(selection)).id ?? '';
            if (id !== selectedId.value || address.value.error) {
                reset();
                selectedId.value = id;
            }
        },
    );
    watch(
        available,
        (value) => {
            if (!value) {
                const unresolved = !!attempt.value;
                stop();
                if (unresolved)
                    notice.value =
                        '报告暂时不可读取。本地问题与原请求已保留；恢复后可明确读取本次结果。';
            }
        },
        { flush: 'sync' },
    );

    async function send(current: QuestionAttempt) {
        if (!available.value || pending.value || waiting.value || terminal.value) return;
        const scope = lifecycle.capture();
        const action = ++generation;
        const signal = controller.signal;
        const isCurrent = () =>
            !disposed &&
            scope.isCurrent() &&
            action === generation &&
            available.value &&
            toValue(reportId) === current.reportId;
        pending.value = true;
        notice.value = '';
        try {
            const response = await scope.request(
                createReportQuestionEndpoint,
                {
                    params: { reportId: current.reportId },
                    body: {
                        question: current.question,
                        ...(current.afterQuestionId !== undefined
                            ? { afterQuestionId: current.afterQuestionId }
                            : {}),
                    },
                },
                { idempotencyKey: current.key, signal },
            );
            if (!isCurrent()) return;
            const currentReport = toValue(report);
            if (!currentReport) invalidQuestion('报告当前不可读取');
            questionResponse(response, currentReport, { question: current.question }, 201);
            const id = response.data.id.toLowerCase();
            const target = optionsFor(id);
            await lifecycle.queryClient.cancelQueries({ queryKey: target.queryKey, exact: true });
            if (!isCurrent()) return;
            lifecycle.queryClient.setQueryData(target.queryKey, { ...response, status: 200 });
            selectedId.value = id;
            draft.value = '';
            attempt.value = undefined;
            terminal.value = false;
            clearWait();
            notice.value = '本次结果已保存。读取已保存回答不会再次调用模型。';
            await conversation.refetch({ cancelRefetch: false });
            await nextTick();
            return id;
        } catch (cause) {
            if (!isCurrent()) return;
            const error = toApiError(cause);
            waitUntil(questionRetryAt(cause));
            terminal.value = error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH';
            if (['CONVERSATION_BUSY', 'CONVERSATION_CHANGED'].includes(error.code ?? '')) {
                attempt.value = undefined;
                const conflictingQuestion = current.question;
                await conversation.refetch({ cancelRefetch: false });
                if (!isCurrent()) return;
                draft.value = conflictingQuestion;
                notice.value = '会话已有新消息或上一轮仍在处理，请查阅历史后再发送。';
                return;
            }
            notice.value = terminal.value
                ? '本次请求标识与服务端问题不一致。请保留原稿并明确结束本次请求后再提出新问题。'
                : error.code === 'QUESTION_PENDING'
                  ? '问题仍在处理中。原问题与请求标识已保留，请稍后明确读取本次结果。'
                  : [429, 503].includes(error.status ?? 0)
                    ? '服务暂不可用或已限流。本次问题可能已保存为不足结果；请保留原稿并明确读取本次结果。'
                    : '本次结果尚未确认，服务端可能已处理。原问题与请求标识已保留，请明确读取本次结果。';
        } finally {
            if (action === generation) pending.value = false;
        }
    }
    function submit() {
        if (!canSubmit.value) return Promise.resolve(undefined);
        const current = questionAttempt(
            toValue(reportId),
            draft.value,
            crypto.randomUUID(),
            turns.value.at(-1)?.id ?? null,
        );
        attempt.value = current;
        return send(current);
    }
    async function recover() {
        if (!canRecover.value) return;
        if (attempt.value) return send(attempt.value);
        const scope = lifecycle.capture();
        const id = selectedId.value;
        await query.refetch({ cancelRefetch: false });
        if (scope.isCurrent() && available.value && id === selectedId.value && answer.value)
            return id;
    }
    /** Caller obtains explicit consent before abandoning an unresolved attempt or local input. */
    function newQuestion() {
        reset();
        selectedId.value = '';
    }
    function cancelPending() {
        if (!pending.value) return;
        stop();
        notice.value = '已停止等待。原问题与请求标识已保留；请读取本次结果确认服务端状态。';
    }
    onScopeDispose(() => {
        disposed = true;
        stop();
        clearWait();
    });
    return {
        draft,
        attempt,
        selectedId,
        pending,
        notice,
        terminal,
        retryAt,
        waiting,
        available,
        address,
        query,
        answer,
        readError,
        protectedState,
        canSubmit,
        conversation,
        conversationData,
        turns,
        canRecover,
        submit,
        recover,
        newQuestion,
        cancelPending,
    };
}
