import {
    computed,
    onScopeDispose,
    ref,
    shallowRef,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from 'vue';
import type { RunCommandResponse } from '@scova/models';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import {
    requestRunAction,
    type RunAction,
    type RunActionTarget,
    type RunAttempt,
} from '@/api/runs';
import { useCommand } from '@/composables/useCommand';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { isActiveRun } from '@/composables/useLatestTaskRun';

export function useRunActions(
    target: MaybeRefOrGetter<RunActionTarget>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const attempt = shallowRef<Readonly<RunAttempt>>();
    const result = shallowRef<RunCommandResponse>();
    const message = ref('');
    const phase = ref<'idle' | 'sending' | 'uncertain' | 'rejected' | 'success'>('idle');
    const command = useCommand();
    const canRetryAfterCancel = computed(
        () =>
            attempt.value?.action === 'cancel' &&
            phase.value === 'success' &&
            ['failed', 'canceled'].includes(toValue(target).run?.status ?? ''),
    );
    const canStartAfterCompletion = computed(() => {
        const latest = toValue(target).latestRun;
        return (
            phase.value === 'success' &&
            attempt.value?.action === 'start' &&
            !!latest &&
            latest.id === result.value?.run.id &&
            !isActiveRun(latest)
        );
    });
    let controller = new AbortController();
    let generation = 0;
    function clear() {
        generation++;
        controller.abort();
        controller = new AbortController();
        attempt.value = undefined;
        result.value = undefined;
        message.value = '';
        phase.value = 'idle';
    }
    watch(
        [
            () => toValue(target).taskId,
            () => toValue(target).run?.id,
            () => lifecycle.session.epoch,
        ],
        clear,
        { flush: 'sync' },
    );
    onScopeDispose(() => {
        clear();
        controller.abort();
    });
    async function send() {
        if (!attempt.value || command.pending.value) return;
        const frozen = attempt.value;
        const current = generation;
        const scope = lifecycle.capture();
        const signal = controller.signal;
        const active = () => current === generation && !signal.aborted && scope.isCurrent();
        await command.run(async () => {
            phase.value = 'sending';
            message.value = '';
            try {
                const response = await requestRunAction(scope, frozen, signal);
                if (!active()) return;
                result.value = response.data;
                phase.value = 'success';
                message.value =
                    frozen.action === 'cancel'
                        ? response.data.run.status === 'cancel_requested'
                            ? '取消请求已提交；等待后台停止，实际状态以执行快照为准。'
                            : '取消请求已处理；执行可能已结束，实际状态以执行快照为准。'
                        : response.data.reused
                          ? ['queued', 'running', 'recovering', 'cancel_requested'].includes(
                                response.data.run.status,
                            )
                              ? '已有活动执行，打开该执行。'
                              : '复用已有执行（可能为同一命令的重放），打开该执行。'
                          : frozen.action === 'retry'
                            ? '已创建关联的新执行，原执行不会恢复。'
                            : '执行已入队。';
                // 不将可能迟到的 cancel_requested 命令响应覆盖 SSE 的终态。
                for (const key of [['run', response.data.run.id], ['runs'], ['tasks']])
                    void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(key) });
            } catch (cause) {
                if (!active()) return;
                const error = toApiError(cause);
                if (error.kind === 'cancelled') return;
                if (error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
                    phase.value = 'rejected';
                    message.value =
                        '命令与原幂等记录不一致（409）；已停止此动作，不会更换 key 重试。';
                } else if (error.code === 'IDEMPOTENCY_PENDING') {
                    phase.value = 'uncertain';
                    message.value = '同一命令仍在处理，可稍后使用同一命令重发。';
                } else if (
                    !error.status ||
                    error.status === 408 ||
                    error.status >= 500 ||
                    error.kind === 'validation' ||
                    error.kind === 'protocol'
                ) {
                    phase.value = 'uncertain';
                    message.value =
                        frozen.action === 'cancel'
                            ? '尚不能确认取消结果，可使用同一命令重新确认取消；不影响任务未来计划。'
                            : '尚不能确认命令结果。请使用同一命令重发，请求与 key 将保持不变。';
                } else {
                    phase.value = 'rejected';
                    message.value =
                        error.code === 'RUN_ALREADY_ACTIVE'
                            ? '已有活动执行（409），请刷新任务或执行快照后查看。'
                            : `命令未完成（${error.status}），请刷新后核对权限与执行状态。`;
                }
            }
        });
    }
    async function submit(action: RunAction) {
        if (
            (attempt.value &&
                !(action === 'retry' && canRetryAfterCancel.value) &&
                !(action === 'start' && canStartAfterCompletion.value)) ||
            command.pending.value ||
            !lifecycle.session.user
        )
            return;
        const value = toValue(target);
        const run = value.run;
        if (
            action === 'start'
                ? !!run ||
                  value.taskStatus === 'archived' ||
                  value.startBlocked ||
                  isActiveRun(value.latestRun)
                : action === 'retry'
                  ? !run || !['failed', 'canceled'].includes(run.status)
                  : !run || !['queued', 'running', 'recovering'].includes(run.status)
        )
            return;
        attempt.value = Object.freeze({
            action,
            taskId: value.taskId,
            runId: run?.id,
            taskVersionId: run?.taskVersionId,
            budget: run ? Object.freeze({ ...run.budget }) : undefined,
            mode: 'live',
            ...(action !== 'cancel' && value.searchMode !== undefined
                ? { searchMode: value.searchMode }
                : {}),
            ...(action !== 'cancel' && value.outputFormat !== undefined
                ? { outputFormat: value.outputFormat }
                : {}),
            ...(action !== 'cancel' && value.outputFormats !== undefined
                ? { outputFormats: [...value.outputFormats] }
                : {}),
            ...(action !== 'cancel' && value.agentProviderId !== undefined
                ? { agentProviderId: value.agentProviderId }
                : {}),
            key: crypto.randomUUID(),
        });
        result.value = undefined;
        await send();
    }
    async function replay() {
        if (phase.value === 'uncertain') await send();
    }
    return {
        attempt,
        result,
        message,
        phase,
        pending: command.pending,
        locked: computed(
            () => !!attempt.value && !canRetryAfterCancel.value && !canStartAfterCompletion.value,
        ),
        submit,
        replay,
    };
}
