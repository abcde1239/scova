<template>
    <section class="run-actions scova-surface" aria-labelledby="run-actions-title">
        <h2 id="run-actions-title">{{ run ? '执行操作' : '立即执行' }}</h2>
        <p v-if="!run && taskStatus === 'archived'">归档任务不能启动执行。</p>
        <template v-else-if="canChoose">
            <p v-if="run">
                原执行：{{
                    run.mode === 'live' ? '真实 live' : '演示 demo'
                }}。重试使用原任务版本与预算，创建关联的新执行。
            </p>
            <fieldset :disabled="actions.locked.value">
                <legend>本次执行模式</legend>
                <label
                    ><input
                        v-model="actions.mode.value"
                        type="radio"
                        value="demo"
                        name="run-mode"
                    />演示 demo</label
                >
                <label
                    ><input
                        v-model="actions.mode.value"
                        type="radio"
                        value="live"
                        name="run-mode"
                    />真实 live</label
                >
            </fieldset>
            <p v-if="actions.mode.value === 'live'">
                真实执行可能调用部署者配置的外部搜索与模型并产生计量费用；缺少配置或服务失败时不会自动切换演示模式。
            </p>
            <p v-else>演示使用示例数据，不代表真实联网研究。</p>
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
                原命令模式：{{
                    actions.attempt.value.mode === 'live' ? '真实 live' : '演示 demo'
                }}。离开或刷新页面会清除此处的重发记录。
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
import type { Run, Task } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useRunActions } from '@/composables/useRunActions';
import { executionStates } from '@/composables/useExecution';
const props = defineProps<{ taskId: string; run?: Run; taskStatus?: Task['status'] }>();
const actions = useRunActions(() => ({
    taskId: props.taskId,
    run: props.run,
    taskStatus: props.taskStatus,
}));
const canChoose = computed(() => !props.run || ['failed', 'canceled'].includes(props.run.status));
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
fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.5rem;
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
}
legend {
    padding: 0 0 0.5rem;
    font-weight: 600;
}
label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    cursor: pointer;
}
input {
    margin: 0;
    inline-size: 1.125rem;
    block-size: 1.125rem;
    accent-color: var(--scova-primary);
    cursor: inherit;
    flex-shrink: 0;
}
fieldset:disabled label {
    cursor: not-allowed;
}
input:focus-visible,
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
