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
import { useQuery } from '@tanstack/vue-query';
import type { Report } from '@scova/models';
import { createReportQuestionEndpoint, reportQuestionEndpoint } from '@/api/report-questions';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
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
} from '@/utils/report-questions';

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
    const protectedState = computed(
        () => pending.value || !!attempt.value || (!selectedId.value && draft.value !== ''),
    );
    const canSubmit = computed(
        () =>
            !!lifecycle.session.user &&
            available.value &&
            !pending.value &&
            !attempt.value &&
            !selectedId.value &&
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
                { params: { reportId: current.reportId }, body: { question: current.question } },
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
            attempt.value = undefined;
            terminal.value = false;
            clearWait();
            notice.value = '本次结果已保存。读取已保存回答不会再次调用模型。';
            await nextTick();
            return id;
        } catch (cause) {
            if (!isCurrent()) return;
            const error = toApiError(cause);
            waitUntil(questionRetryAt(cause));
            terminal.value = error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH';
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
        const current = questionAttempt(toValue(reportId), draft.value);
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
        canRecover,
        submit,
        recover,
        newQuestion,
    };
}
