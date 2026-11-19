import { computed, reactive, ref, watch } from 'vue';
import {
    ContractValidationError,
    TaskConfigSchema,
    parseContract,
    type TaskConfig,
    type TaskDetailResponse,
} from '@scova/models';
import { createTaskEndpoint, taskKeys } from '@/api/tasks';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { useCommand } from '@/composable/useCommand';
import { useSessionMutation } from '@/composable/useSessionQuery';
import { initialTaskDraft, type TaskDraftField, taskInput, taskDraftFromConfig } from './draft.ts';
import { taskValidationFields, saveNotConfirmed } from './fields.ts';

export function createTaskController(lifecycle: SessionLifecycle) {
    const owner = lifecycle.capture();
    const draft = reactive(initialTaskDraft(lifecycle.session.user?.preferences));
    const inputText = ref('');
    const keepSuggestedSchedule = ref(true);
    const parsedConfig = ref<TaskConfig>();
    const editRevision = ref(0);
    const stopEdits = watch(
        [() => JSON.stringify(draft), inputText, keepSuggestedSchedule],
        () => {
            editRevision.value++;
        },
        { flush: 'sync' },
    );
    const initial = JSON.stringify(draft);
    const command = useCommand();
    const mutation = useSessionMutation(createTaskEndpoint, lifecycle);
    const fields = ref<Partial<Record<TaskDraftField, string>>>({});
    const message = ref('');
    const saved = ref(false);
    const uncertain = ref(false);
    const expired = ref(false);
    const controller = new AbortController();
    let disposed = false;
    let attempt: { body: string; key: string } | undefined;
    const dirty = computed(
        () => !saved.value && (JSON.stringify(draft) !== initial || inputText.value.length > 0),
    );
    const unregister = owner.registerCleanup(() => {
        expired.value = true;
        controller.abort();
        Object.assign(draft, initialTaskDraft());
        inputText.value = '';
        parsedConfig.value = undefined;
        fields.value = {};
        message.value = '';
    });

    async function submit(): Promise<TaskDetailResponse | undefined> {
        if (disposed || saved.value || expired.value || !owner.isCurrent() || uncertain.value)
            return;
        return command.run(async () => {
            fields.value = {};
            message.value = '';
            let config: TaskConfig | undefined;
            try {
                const input = {
                    ...taskInput(draft, parsedConfig.value, keepSuggestedSchedule.value),
                    ...(inputText.value.trim() ? { inputText: inputText.value } : {}),
                };
                config = input.config;
                const body = JSON.stringify(input);
                if (!attempt || attempt.body !== body) attempt = { body, key: crypto.randomUUID() };
                const result = await mutation.mutateAsync({
                    input: { body: input },
                    options: { idempotencyKey: attempt.key, signal: controller.signal },
                });
                if (disposed || !owner.isCurrent()) return;
                saved.value = true;
                await lifecycle.queryClient.invalidateQueries({
                    queryKey: owner.queryKey(taskKeys.all),
                });
                return owner.isCurrent() && !disposed ? result.data : undefined;
            } catch (cause) {
                if (disposed || !owner.isCurrent()) return;
                const error = toApiError(cause);
                if (error.kind === 'cancelled') return;
                uncertain.value = !!config && saveNotConfirmed(error.status);
                if (uncertain.value) {
                    message.value = '保存结果未确认，请先返回任务列表核对，避免重复创建。';
                    return;
                }
                const details =
                    cause instanceof ContractValidationError
                        ? cause.fieldErrors
                        : error.fieldErrors;
                // Union 的不匹配分支会返回额外字段，只关联当前可见时间范围。
                fields.value = taskValidationFields(draft.rangeKind, details);
                if (Object.keys(fields.value).length) message.value = '请检查标出的字段';
                else {
                    message.value =
                        error.status === 403
                            ? '没有保存权限，请检查账号或重新登录'
                            : error.status === 429
                              ? '保存过于频繁，请稍后重试'
                              : '任务未保存，请稍后重试';
                }
            }
        });
    }
    function canLeave(confirm: () => boolean) {
        if (expired.value || !owner.isCurrent()) return true;
        if (command.pending.value) return false;
        return !dirty.value || confirm();
    }
    function applyParsed(config: TaskConfig) {
        if (
            disposed ||
            !owner.isCurrent() ||
            command.pending.value ||
            uncertain.value ||
            expired.value ||
            saved.value
        )
            return false;
        const valid = parseContract(TaskConfigSchema, config);
        parsedConfig.value = JSON.parse(JSON.stringify(valid)) as TaskConfig;
        Object.assign(draft, taskDraftFromConfig(valid), {
            agentProviderId: draft.agentProviderId,
            searchMode: draft.searchMode,
            researchMode: valid.researchMode ?? draft.researchMode,
        });
        keepSuggestedSchedule.value = true;
        fields.value = {};
        message.value = '';
        return true;
    }
    function dispose() {
        disposed = true;
        controller.abort();
        stopEdits();
        unregister();
    }
    return {
        draft,
        inputText,
        keepSuggestedSchedule,
        parsedConfig,
        editRevision,
        applyParsed,
        dirty,
        pending: command.pending,
        fields,
        message,
        saved,
        uncertain,
        expired,
        submit,
        canLeave,
        dispose,
    };
}
