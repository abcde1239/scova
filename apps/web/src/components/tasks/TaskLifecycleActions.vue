<template>
    <section class="task-lifecycle scova-surface" aria-labelledby="task-lifecycle-title">
        <h2 id="task-lifecycle-title">任务计划与归档</h2>
        <template v-if="actions.snapshot.value">
            <p>当前状态：{{ statusLabels[actions.snapshot.value.data.task.status] }}</p>
            <p v-if="actions.snapshot.value.data.task.status === 'archived'">
                任务已归档，不能恢复或启动新执行。已有报告与历史保留。
            </p>
            <template v-else>
                <p v-if="actions.snapshot.value.data.task.status === 'active'">
                    暂停只停止未来计划，在途执行继续，仍可显式手动执行。
                </p>
                <p v-else>恢复只重新安排未来计划，不补跑暂停期间的历史时点。</p>
                <p v-if="actions.snapshot.value.data.task.nextRunAt">
                    下次计划：<time :datetime="actions.snapshot.value.data.task.nextRunAt">{{
                        time(actions.snapshot.value.data.task.nextRunAt)
                    }}</time
                    >（任务时区 {{ actions.snapshot.value.data.version.config.timezone }}）
                </p>
                <p
                    v-else-if="
                        actions.snapshot.value.data.version.config.schedule.frequency === 'manual'
                    "
                >
                    该任务仅手动执行，没有周期计划。
                </p>
                <div class="lifecycle-buttons">
                    <action-button
                        v-if="actions.snapshot.value.data.task.status === 'active'"
                        :disabled="actions.disabled.value && !actions.pending.value"
                        :busy="actions.pending.value"
                        @click="actions.submit('pause')"
                        ><app-icon name="pause" />暂停未来计划</action-button
                    >
                    <action-button
                        v-else
                        :disabled="actions.disabled.value && !actions.pending.value"
                        :busy="actions.pending.value"
                        @click="actions.submit('resume')"
                        ><app-icon name="run" />恢复未来计划</action-button
                    >
                    <action-button
                        ref="archiveTrigger"
                        class="danger"
                        :disabled="actions.disabled.value"
                        @click="openArchive"
                        ><app-icon name="archive" />归档任务</action-button
                    >
                </div>
            </template>
        </template>
        <p v-else>{{ actions.refreshing.value ? '正在读取任务状态' : '任务状态暂不可用' }}</p>
        <div
            v-if="actions.message.value"
            ref="feedback"
            class="lifecycle-feedback"
            role="status"
            aria-live="polite"
            tabindex="-1"
        >
            <p>{{ actions.message.value }}</p>
        </div>
        <action-button
            :disabled="actions.pending.value"
            :busy="actions.refreshing.value"
            @click="actions.refresh()"
            ><app-icon name="retry" />刷新任务状态</action-button
        >
        <dialog
            ref="confirmationDialog"
            aria-labelledby="archive-title"
            aria-describedby="archive-consequence"
            @cancel.prevent="cancelArchive"
        >
            <h2 id="archive-title">归档任务？</h2>
            <p id="archive-consequence" tabindex="0">
                归档将停止未来计划、阻止新执行，并对活动执行请求取消；取消完成前仍可能有在途工作。配置版本、报告与历史会保留。归档后不能恢复任务。
            </p>
            <div class="lifecycle-buttons">
                <action-button ref="cancelTrigger" @click="cancelArchive">取消</action-button>
                <action-button
                    class="danger"
                    :busy="actions.pending.value"
                    :disabled="!actions.confirmation.value"
                    @click="confirmArchive"
                    ><app-icon name="archive" />确认归档</action-button
                >
            </div>
        </dialog>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useTaskLifecycle } from '@/composables/useTaskLifecycle';
const props = defineProps<{ taskId: string }>();
const actions = useTaskLifecycle(() => props.taskId);
const statusLabels = { active: '进行中', paused: '已暂停', archived: '已归档' };
const confirmationDialog = ref<HTMLDialogElement>();
const archiveTrigger = ref<{ $el: HTMLButtonElement }>();
const cancelTrigger = ref<{ $el: HTMLButtonElement }>();
const feedback = ref<HTMLElement>();
function time(instant: string) {
    return new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: actions.snapshot.value?.data.version.config.timezone,
    }).format(new Date(instant));
}
async function openArchive() {
    if (!actions.prepareArchive()) return;
    confirmationDialog.value?.showModal();
    await nextTick();
    cancelTrigger.value?.$el.focus();
}
async function cancelArchive() {
    confirmationDialog.value?.close();
    actions.cancelArchive();
    await nextTick();
    const element = archiveTrigger.value?.$el;
    if (element?.isConnected && !element.disabled) element.focus();
}
async function confirmArchive() {
    confirmationDialog.value?.close();
    await actions.submit('archive');
}
watch(actions.confirmation, (value) => {
    if (!value) confirmationDialog.value?.close();
});
watch([actions.message, actions.pending, actions.refreshing], async () => {
    if (!actions.message.value || actions.pending.value || actions.refreshing.value) return;
    await nextTick();
    feedback.value?.focus();
});
</script>

<style scoped>
.task-lifecycle {
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
.lifecycle-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
}
.task-lifecycle > :deep(.scova-action-button) {
    justify-self: start;
}
.danger,
.danger :deep(.n-button__content) {
    color: var(--scova-danger);
}
.danger :deep(.n-button__border),
.danger :deep(.n-button__state-border) {
    border-color: var(--scova-danger);
}
.lifecycle-feedback:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
dialog {
    box-sizing: border-box;
    inline-size: min(34rem, calc(100% - 2rem));
    max-block-size: calc(100dvh - 2rem);
    padding: clamp(1rem, 4%, 2rem);
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
    color: var(--scova-text);
    background: var(--scova-surface);
    overflow: hidden;
}
dialog[open] {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 1.5rem;
}
dialog h2,
dialog p {
    margin: 0;
}
#archive-consequence {
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
}
#archive-consequence:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: -0.125rem;
}
dialog::backdrop {
    background: rgb(0 0 0 / 45%);
}
</style>
