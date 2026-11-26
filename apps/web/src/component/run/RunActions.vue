<template>
    <section
        class="run-actions scova-surface layout-stack rounded-3 break-anywhere p-[clamp(1rem,_3%,_2rem)] [&.run-actions_>_.scova-action-button]:justify-self-start"
        aria-labelledby="run-actions-title"
    >
        <h2 class="text-[1.25rem] leading-[1.5] m-0" id="run-actions-title" tabindex="-1">
            {{ run ? '执行操作' : '立即执行' }}
        </h2>
        <p v-if="!run && taskStatus === 'archived'">归档任务不能启动执行。</p>
        <template v-else-if="canStart">
            <task-execution-settings
                v-model:agent="agentSelection"
                v-model:search="searchSelection"
                inherit
                :retry="!!run"
                :disabled="startBlocked || actions.locked.value || actions.pending.value"
            >
                <router-link class="navigation-link" :to="{ name: 'task-edit', params: { taskId } }"
                    >任务配置编辑页<app-icon name="chevron" />
                </router-link>
            </task-execution-settings>
            <action-button
                :disabled="startBlocked || (actions.locked.value && !actions.pending.value)"
                :busy="actions.pending.value"
                @click="actions.submit(run ? 'retry' : 'start')"
            >
                <app-icon :name="run ? 'retry' : 'run'" />{{
                    run ? '重试并创建新执行' : activeRun ? '执行进行中' : '立即执行'
                }}
            </action-button>
            <template v-if="!run">
                <p v-if="latestQuery.isPending.value" role="status">正在读取执行状态…</p>
                <div v-else-if="latestQuery.isError.value" class="layout-stack">
                    <p role="status">执行状态暂不可用</p>
                    <action-button
                        :busy="latestQuery.isFetching.value"
                        @click="latestQuery.refetch()"
                        >重新读取执行状态</action-button
                    >
                </div>
                <router-link v-if="activeRun" class="navigation-link" :to="`/runs/${activeRun.id}`"
                    >查看当前执行<app-icon name="chevron"
                /></router-link>
            </template>
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
            v-if="
                actions.phase.value === 'uncertain' ||
                (actions.result.value && actions.attempt.value?.action !== 'cancel')
            "
            ref="feedback"
            class="command-result keyboard-focus-wide layout-stack [&.command-result_.scova-action-button]:justify-self-start"
            tabindex="-1"
        >
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
                        actions.result.value.run.mode === 'live' ? '任务执行' : '演示执行'
                    }}
                    · {{ executionStates[actions.result.value.run.status][0] }}
                </p>
                <router-link
                    class="open-run navigation-link"
                    :to="`/runs/${actions.result.value.run.id}`"
                    >查看执行<app-icon name="chevron"
                /></router-link>
            </template>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { parseContract, SearchModeSchema, type Run, type Task } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import TaskExecutionSettings from '@/component/tasks/TaskExecutionSettings.vue';
import { useRunActions } from '@/composable/useRunActions';
import { useActionNotification } from '@/composable/useActionNotification';
import { executionStates } from '@/composable/useExecution';
import { useLatestTaskRun, isActiveRun } from '@/composable/useLatestTaskRun';
const props = defineProps<{
    taskId: string;
    run?: Run;
    taskStatus?: Task['status'];
}>();
const agentSelection = ref('');
const searchSelection = ref('');
const { query: latestQuery, latest } = useLatestTaskRun(
    () => props.taskId,
    () => !props.run && props.taskStatus !== 'archived',
);
const activeRun = computed(() => (isActiveRun(latest.value) ? latest.value : undefined));
const startBlocked = computed(
    () =>
        !props.run &&
        (latestQuery.isPending.value ||
            latestQuery.isError.value ||
            latestQuery.isFetching.value ||
            !!activeRun.value),
);
const actions = useRunActions(() => ({
    taskId: props.taskId,
    run: props.run,
    taskStatus: props.taskStatus,
    latestRun: latest.value,
    startBlocked: startBlocked.value,
    searchMode: searchSelection.value
        ? parseContract(SearchModeSchema, searchSelection.value)
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
        searchSelection.value = '';
    },
);
const canStart = computed(() => !props.run || ['failed', 'canceled'].includes(props.run.status));
useActionNotification().watch(actions.message, () =>
    actions.phase.value === 'success'
        ? 'success'
        : actions.phase.value === 'rejected'
          ? 'error'
          : 'warning',
);
const feedback = ref<HTMLElement>();
watch(actions.phase, async (phase) => {
    if (!['success', 'uncertain'].includes(phase)) return;
    await nextTick();
    if (actions.phase.value === phase) feedback.value?.focus();
});
</script>
