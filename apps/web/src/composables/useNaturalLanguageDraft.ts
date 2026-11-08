import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type {
    TaskDraftResponse,
    TaskDraftScope,
    TaskClarifications,
    TaskDraftQuestionsResponse,
    TaskDraftUsage,
} from '@scova/models';
import { ContractValidationError } from '@scova/models';
import type { SessionLifecycle } from '@/api/session';
import { requestTaskDraft, requestTaskQuestions, validateDraftInput } from '@/api/task-drafts';
import { toApiError } from '@/api/errors';
import type { createTaskController } from '@/composables/useCreateTask';
import { useCommand } from '@/composables/useCommand';
import { useSessionLifecycle } from '@/composables/useSessionQuery';

export function useNaturalLanguageDraft(
    task: ReturnType<typeof createTaskController>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
    options: { timeout?: number } = {},
) {
    const command = useCommand();
    const timezone = ref(task.draft.timezone);
    const result = shallowRef<TaskDraftResponse>();
    const clarificationResult = shallowRef<TaskDraftQuestionsResponse>();
    const clarifications = shallowRef<TaskClarifications>([]);
    const clarificationUsage = ref<TaskDraftUsage>({
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimated: false,
    });
    const clarifying = ref(false);
    const message = ref('');
    const inputError = ref('');
    const timezoneError = ref('');
    const capturedRevision = ref(-1);
    const timezoneRevision = ref(0);
    const searchScope = shallowRef<TaskDraftScope>();
    let capturedScope: TaskDraftScope | undefined;
    let capturedTimezoneRevision = -1;
    const applied = ref(false);
    let generation = 0;
    let controller = new AbortController();
    const unavailable = computed(
        () => task.pending.value || task.uncertain.value || task.expired.value || task.saved.value,
    );
    const stale = computed(
        () =>
            !!result.value &&
            !applied.value &&
            (capturedRevision.value !== task.editRevision.value ||
                capturedTimezoneRevision !== timezoneRevision.value ||
                capturedScope !== searchScope.value),
    );
    const canApply = computed(
        () =>
            !!result.value &&
            !stale.value &&
            !applied.value &&
            !command.pending.value &&
            !unavailable.value,
    );
    const stopTimezone = watch(
        timezone,
        () => {
            timezoneRevision.value++;
            resetConversation();
        },
        { flush: 'sync' },
    );
    const stopInput = watch(
        task.inputText,
        () => {
            searchScope.value = undefined;
            resetConversation();
        },
        { flush: 'sync' },
    );
    function resetConversation() {
        clarificationResult.value = undefined;
        clarifications.value = [];
        clarificationUsage.value = {
            attempts: 0,
            inputTokens: 0,
            outputTokens: 0,
            estimated: false,
        };
    }
    function clear() {
        generation++;
        controller.abort();
        controller = new AbortController();
        result.value = undefined;
        message.value = '';
        inputError.value = '';
        timezoneError.value = '';
        applied.value = false;
    }
    const stopSession = watch(
        () => lifecycle.session.epoch,
        () => {
            clear();
            resetConversation();
            searchScope.value = undefined;
            timezone.value = lifecycle.session.user?.preferences.defaultTimezone ?? 'Asia/Shanghai';
        },
        { flush: 'sync' },
    );
    onScopeDispose(() => {
        clear();
        controller.abort();
        stopTimezone();
        stopInput();
        stopSession();
    });

    async function parse() {
        if (command.pending.value || unavailable.value || !lifecycle.session.user) return;
        await command.run(async () => {
            clear();
            const scope = lifecycle.capture();
            const current = generation;
            const signal = controller.signal;
            capturedRevision.value = task.editRevision.value;
            capturedTimezoneRevision = timezoneRevision.value;
            capturedScope = searchScope.value;
            try {
                const input = validateDraftInput({
                    inputText: task.inputText.value,
                    ...(timezone.value ? { timezone: timezone.value } : {}),
                    ...(capturedScope ? { searchScope: capturedScope } : {}),
                    ...(clarifications.value.length
                        ? { clarifications: clarifications.value }
                        : {}),
                });
                const response = await requestTaskDraft(scope, input, signal, options.timeout);
                if (current !== generation || signal.aborted || !scope.isCurrent()) return;
                result.value = response.data;
                message.value = stale.value
                    ? '解析期间原文或表单已变化，当前配置未改动。请重新解析或继续手工填写。'
                    : '请检查建议配置，再应用到下方表单。';
            } catch (cause) {
                if (current !== generation || signal.aborted || !scope.isCurrent()) return;
                const error = toApiError(cause);
                if (error.kind === 'cancelled') return;
                const fields =
                    cause instanceof ContractValidationError
                        ? cause.fieldErrors
                        : error.fieldErrors;
                inputError.value = fields?.find(
                    (field) => field.path === '/inputText' || field.path === '/body/inputText',
                )
                    ? !task.inputText.value.trim()
                        ? '请先描述你想研究的内容。'
                        : '需求描述最多输入 2000 字，请精简后再试。'
                    : '';
                timezoneError.value = fields?.find(
                    (field) => field.path === '/timezone' || field.path === '/body/timezone',
                )
                    ? '请从列表中选择有效时区。'
                    : '';
                message.value =
                    inputError.value || timezoneError.value
                        ? '请检查需求描述和时区，也可以直接手动填写。'
                        : error.status === 429
                          ? '解析过于频繁，请稍后再试，或直接手工填写。原文已保留。'
                          : error.kind === 'timeout' || error.status === 408
                            ? '解析超时，原文已保留，可以直接手工填写。'
                            : '暂时无法取得合法解析草稿，原文与手工配置已保留，可以继续手工填写。';
            }
        });
    }
    function apply() {
        if (!canApply.value || !result.value || !task.applyParsed(result.value.config))
            return false;
        applied.value = true;
        message.value = '已应用到下方表单，请检查后保存任务。';
        return true;
    }
    function cancel() {
        clear();
        clarificationResult.value = undefined;
        message.value = '解析已停止，原文已保留，可以继续手工填写。';
    }
    async function clarify(answers?: Record<string, string>) {
        if (command.pending.value || unavailable.value || !lifecycle.session.user) return;
        const previous = answers ? clarificationResult.value : undefined;
        if (answers && (!previous || !previous.questions.length || previous.round >= 2)) return;
        const additions =
            previous?.questions.map((q) => ({
                question: q.question,
                answer: answers?.[q.id]?.trim() ?? '',
            })) ?? [];
        if (additions.some((item) => !item.answer || item.answer.length > 2000)) {
            message.value = '请逐项回答 AI 的问题，每项最多 2000 字；也可直接手动填写。';
            return;
        }
        await command.run(async () => {
            clear();
            if (!answers) resetConversation();
            clarifying.value = true;
            const session = lifecycle.capture();
            const current = generation;
            const revision = task.editRevision.value;
            const timezoneVersion = timezoneRevision.value;
            const signal = controller.signal;
            try {
                const input = validateDraftInput({
                    inputText: task.inputText.value,
                    ...(timezone.value ? { timezone: timezone.value } : {}),
                });
                const transcript = [...clarifications.value, ...additions];
                const response = await requestTaskQuestions(
                    session,
                    {
                        ...input,
                        clarifications: transcript,
                        round: previous ? previous.round + 1 : 0,
                    },
                    signal,
                    options.timeout,
                );
                if (current !== generation || signal.aborted || !session.isCurrent()) return;
                if (
                    revision !== task.editRevision.value ||
                    timezoneVersion !== timezoneRevision.value
                ) {
                    resetConversation();
                    message.value =
                        '问答期间原文、时区或表单已变化，请重新整理需求；当前配置已保留。';
                    return;
                }
                clarificationResult.value = response.data;
                clarifications.value = transcript;
                const usage = response.data.parsingUsage;
                clarificationUsage.value = {
                    attempts: clarificationUsage.value.attempts + usage.attempts,
                    inputTokens: clarificationUsage.value.inputTokens + usage.inputTokens,
                    outputTokens: clarificationUsage.value.outputTokens + usage.outputTokens,
                    estimated: clarificationUsage.value.estimated || usage.estimated,
                };
                message.value =
                    response.data.mode === 'manual'
                        ? response.data.summary
                        : response.data.questions.length
                          ? '请回答 AI 根据需求提出的问题，也可以补充自己的要求。'
                          : 'AI 已整理搜索范围，请核对后再生成任务草稿。';
            } catch (cause) {
                if (current !== generation || signal.aborted || !session.isCurrent()) return;
                const error = toApiError(cause);
                if (error.kind === 'cancelled') return;
                if (cause instanceof ContractValidationError) {
                    inputError.value = !task.inputText.value.trim()
                        ? '请先描述你想研究的内容。'
                        : '需求描述最多输入 2000 字，请精简后再试。';
                    if (cause.fieldErrors.some((f) => f.path === '/timezone')) {
                        inputError.value = '';
                        timezoneError.value = '请从列表中选择有效时区。';
                    }
                }
                message.value =
                    inputError.value ||
                    timezoneError.value ||
                    (error.status === 429
                        ? '解析过于频繁，请稍后再试，或直接手工填写。原文和回答已保留。'
                        : 'AI 问答暂时无法继续，原文和已有回答已保留，可重试或手动填写。');
            } finally {
                clarifying.value = false;
            }
        });
    }
    return {
        timezone,
        clarificationResult,
        clarifications,
        clarificationUsage,
        clarifying,
        clarify,
        searchScope,
        result,
        message,
        inputError,
        timezoneError,
        stale,
        applied,
        canApply,
        unavailable,
        pending: command.pending,
        parse,
        apply,
        cancel,
    };
}
