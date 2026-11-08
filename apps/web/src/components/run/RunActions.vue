<template>
    <section class="run-actions scova-surface" aria-labelledby="run-actions-title">
        <h2 id="run-actions-title">{{ run ? '执行操作' : '立即执行' }}</h2>
        <p v-if="!run && taskStatus === 'archived'">归档任务不能启动执行。</p>
        <template v-else-if="canStart">
            <p v-if="run">
                原执行：{{
                    run.mode === 'live' ? '真实 live' : '演示 demo'
                }}。重试使用原任务版本与预算，创建关联的新执行。
            </p>
            <p>执行会调用已配置的搜索与模型，可能产生服务费用；缺少配置时会明确报错。</p>
            <task-config-field
                v-model="outputSelection"
                label="本次输出形式"
                kind="select"
                :options="outputOptions"
                :disabled="actions.locked.value || actions.pending.value"
            />
            <p>选择需要的形式后执行。此选择仅用于本次新执行；报告打开后也可切换阅读布局。</p>
            <execution-agent-select
                v-model="agentSelection"
                inherit
                :disabled="actions.locked.value || actions.pending.value"
                hint="仅影响本次新执行，重试仍保留原任务版本和预算。"
            />
            <action-button
                :disabled="actions.locked.value && !actions.pending.value"
                :busy="actions.pending.value"
                @click="actions.submit(run ? 'retry' : 'start')"
            >
                <app-icon :name="run ? 'retry' : 'run'" />{{
                    run ? '重试并创建新执行' : '立即执行'
                }}
            </action-button>
        </template>
        <template
            v-else-if="
                run && ['queued', 'running', 'recovering', 'cancel_requested'].includes(run.status)
            "
        >
            <p>取消仅影响本次执行，不暂停任务的未来计划。</p>
            <action-button
                :disabled="
                    run.status === 'cancel_requested' ||
                    (actions.locked.value && !actions.pending.value)
                "
                :busy="actions.pending.value"
                @click="actions.submit('cancel')"
            >
                <app-icon name="cancel" />{{
                    run.status === 'cancel_requested' ? '正在取消' : '请求取消'
                }}
            </action-button>
        </template>
        <p v-else>本次执行不提供失败重试。使用任务页的“立即执行”可按当前任务版本新建执行。</p>
        <div
            v-if="actions.message.value"
            ref="feedback"
            class="command-result"
            role="status"
            aria-live="polite"
            tabindex="-1"
        >
            <p>{{ actions.message.value }}</p>
            <p
                v-if="
                    actions.attempt.value &&
                    actions.attempt.value.action !== 'cancel' &&
                    actions.phase.value === 'uncertain'
                "
            >
                离开或刷新页面会清除此处的重发记录。
            </p>
            <action-button
                v-if="actions.phase.value === 'uncertain'"
                :busy="actions.pending.value"
                @click="actions.replay()"
                ><app-icon name="retry" />使用同一命令重发</action-button
            >
            <template v-if="actions.result.value && actions.attempt.value?.action !== 'cancel'">
                <p>
                    实际执行：{{
                        actions.result.value.run.mode === 'live' ? '真实 live' : '演示 demo'
                    }}
                    · {{ executionStates[actions.result.value.run.status][0] }}
                </p>
                <router-link
                    class="open-run scova-reference"
                    :to="`/runs/${actions.result.value.run.id}`"
                    >打开执行<app-icon name="run"
                /></router-link>
            </template>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
    parseContract,
    OutputFormatSchema,
    type Run,
    type Task,
    type TaskConfig,
} from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import ExecutionAgentSelect from '@/components/tasks/ExecutionAgentSelect.vue';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import { useRunActions } from '@/composables/useRunActions';
import { executionStates } from '@/composables/useExecution';
const props = defineProps<{
    taskId: string;
    run?: Run;
    taskStatus?: Task['status'];
    outputFormat?: TaskConfig['outputFormat'];
}>();
const agentSelection = ref('');
const outputSelection = ref('');
const formatLabels = {
    brief: '简报',
    list: '主题清单',
    comparison: '对比表',
    research_report: '研究报告',
};
const outputOptions = computed(() => [
    {
        value: '',
        label: props.outputFormat
            ? `沿用任务设置（${formatLabels[props.outputFormat]}）`
            : '沿用原配置',
    },
    ...Object.entries(formatLabels).map(([value, label]) => ({ value, label })),
]);
const actions = useRunActions(() => ({
    taskId: props.taskId,
    run: props.run,
    taskStatus: props.taskStatus,
    outputFormat: outputSelection.value
        ? parseContract(OutputFormatSchema, outputSelection.value)
        : undefined,
    agentProviderId:
        agentSelection.value === ''
            ? undefined
            : agentSelection.value === '__default'
              ? null
              : agentSelection.value,
}));
watch(
    () => `${props.taskId}:${props.run?.id ?? ''}`,
    () => {
        agentSelection.value = '';
        outputSelection.value = '';
    },
);
const canStart = computed(() => !props.run || ['failed', 'canceled'].includes(props.run.status));
const feedback = ref<HTMLElement>();
watch(actions.phase, async (phase) => {
    if (!['success', 'uncertain', 'rejected'].includes(phase)) return;
    await nextTick();
    if (actions.phase.value === phase) feedback.value?.focus();
});
</script>

<style scoped>
.run-actions {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    padding: clamp(1rem, 3%, 2rem);
    border-radius: 0.75rem;
    overflow-wrap: anywhere;
}
h2 {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.5;
}
.open-run:focus-visible,
.command-result:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.run-actions > :deep(.scova-action-button) {
    justify-self: start;
}
.command-result {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
}
.command-result :deep(.scova-action-button) {
    justify-self: start;
}
.open-run {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    justify-self: start;
    min-block-size: 2.75rem;
    cursor: pointer;
}
</style>
