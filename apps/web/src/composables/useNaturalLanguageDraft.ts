import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { TaskDraftResponse } from '@scova/models';
import { ContractValidationError } from '@scova/models';
import type { SessionLifecycle } from '@/api/session';
import { requestTaskDraft, validateDraftInput } from '@/api/task-drafts';
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
    const message = ref('');
    const inputError = ref('');
    const timezoneError = ref('');
    const capturedRevision = ref(-1);
    const timezoneRevision = ref(0);
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
                capturedTimezoneRevision !== timezoneRevision.value),
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
        },
        { flush: 'sync' },
    );
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
            timezone.value = lifecycle.session.user?.preferences.defaultTimezone ?? 'Asia/Shanghai';
        },
        { flush: 'sync' },
    );
    onScopeDispose(() => {
        clear();
        controller.abort();
        stopTimezone();
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
            try {
                const input = validateDraftInput({
                    inputText: task.inputText.value,
                    ...(timezone.value ? { timezone: timezone.value } : {}),
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
        message.value = '解析已停止，原文已保留，可以继续手工填写。';
    }
    return {
        timezone,
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
