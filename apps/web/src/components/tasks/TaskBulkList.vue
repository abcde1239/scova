<template>
    <div class="task-bulk-list">
        <div v-if="tasks.length || managing" class="bulk-toolbar">
            <action-button
                v-if="!managing"
                ref="manageTrigger"
                :disabled="unavailable"
                @click="managing = true"
                >批量管理</action-button
            >
            <template v-else>
                <p>已选 {{ actions.selected.value.length }} 个任务</p>
                <action-button :disabled="locked || !tasks.length" @click="actions.selectLoaded()"
                    >选择已加载任务</action-button
                >
                <action-button
                    :disabled="locked || !actions.selected.value.length"
                    @click="actions.clearSelection()"
                    >取消选择</action-button
                >
                <action-button
                    ref="clearTrigger"
                    class="danger"
                    :disabled="
                        unavailable || actions.pending.value || !actions.selected.value.length
                    "
                    :busy="actions.preparing.value"
                    @click="openConfirmation"
                    >清除所选任务</action-button
                >
                <action-button :disabled="actions.busy.value" @click="finishManaging"
                    >退出批量管理</action-button
                >
            </template>
        </div>
        <p v-if="managing" class="selection-note">
            仅选择当前筛选下已加载的任务，每批最多
            {{ bulkTaskLimit }}
            个；加载更多不会自动选中。启用状态不代表正在执行，清除时会检查活动执行。
        </p>
        <div
            v-if="actions.message.value || actions.results.value.length"
            ref="feedback"
            class="bulk-feedback"
            role="status"
            tabindex="-1"
        >
            <p>{{ actions.message.value }}</p>
            <ul v-if="actions.results.value.length">
                <li v-for="result in actions.results.value" :key="result.id">
                    {{ result.title }}：{{ result.message }}
                </li>
            </ul>
        </div>
        <div class="task-list">
            <div
                v-for="task in tasks"
                :key="task.id"
                class="task-entry"
                :class="{ selecting: managing }"
            >
                <label v-if="managing" class="task-select">
                    <input
                        type="checkbox"
                        :aria-label="`选择任务：${task.title}`"
                        :checked="isSelected(task.id)"
                        :disabled="
                            locked ||
                            (!isSelected(task.id) && actions.selected.value.length >= bulkTaskLimit)
                        "
                        @change="actions.toggle(task)"
                    />
                    <span>选择</span>
                </label>
                <task-card :task="task" :filter="filter" :timezone="timezone" />
            </div>
        </div>
        <dialog
            ref="dialog"
            aria-labelledby="bulk-delete-title"
            aria-describedby="bulk-delete-consequence"
            @cancel.prevent="cancel"
        >
            <h2 id="bulk-delete-title">
                永久清除 {{ actions.confirmation.value.length }} 个任务？
            </h2>
            <div class="confirmation-body">
                <p id="bulk-delete-consequence">
                    将永久删除以下任务及其配置版本、执行历史、报告、通知、报告笔记和问答，无法恢复。共享来源、网页快照和来源收藏保留。有活动执行或修订变化的任务不会被清除。
                </p>
                <ul>
                    <li v-for="item in actions.confirmation.value" :key="item.data.task.id">
                        {{ item.data.task.title }}
                    </li>
                </ul>
                <label class="confirmation-input"
                    >请输入“{{ actions.phrase.value }}”以确认
                    <input
                        v-model="confirmationText"
                        :disabled="actions.pending.value"
                        autocomplete="off"
                        spellcheck="false"
                    />
                </label>
                <p>
                    任务会逐项清除，可能只完成其中一部分；遇到结果不明的请求会停止后续清除，请刷新列表核对。
                </p>
                <p v-if="actions.pending.value" role="status">
                    正在清除，已处理 {{ actions.results.value.length }}/{{
                        actions.confirmation.value.length
                    }}
                    个任务
                </p>
            </div>
            <div class="dialog-actions">
                <action-button ref="cancelTrigger" :disabled="actions.pending.value" @click="cancel"
                    >取消</action-button
                >
                <action-button
                    class="danger"
                    :disabled="
                        confirmationText.trim() !== actions.phrase.value ||
                        !actions.confirmation.value.length
                    "
                    :busy="actions.pending.value"
                    @click="actions.remove(confirmationText)"
                    >确认永久清除</action-button
                >
            </div>
        </dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Task } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import TaskCard from '@/components/tasks/TaskCard.vue';
import { bulkTaskLimit, useBulkTaskDeletion } from '@/composables/useBulkTaskDeletion';
import type { TaskFilter } from '@/composables/useTasks';
const props = defineProps<{
    tasks: Task[];
    filter: TaskFilter;
    timezone: string;
    unavailable: boolean;
}>();
const actions = useBulkTaskDeletion(() => props.tasks);
const managing = ref(false);
const confirmationText = ref('');
const dialog = ref<HTMLDialogElement>();
const cancelTrigger = ref<{ $el: HTMLButtonElement }>();
const clearTrigger = ref<{ $el: HTMLButtonElement }>();
const manageTrigger = ref<{ $el: HTMLButtonElement }>();
const feedback = ref<HTMLElement>();
const locked = computed(
    () => props.unavailable || actions.busy.value || !!actions.confirmation.value.length,
);
const isSelected = (id: string) => actions.selected.value.some((task) => task.id === id);
async function openConfirmation() {
    if (props.unavailable || !(await actions.prepare())) return;
    confirmationText.value = '';
    dialog.value?.showModal();
    await nextTick();
    cancelTrigger.value?.$el.focus();
}
async function cancel() {
    if (actions.pending.value) return;
    actions.cancel();
    dialog.value?.close();
    confirmationText.value = '';
    await nextTick();
    clearTrigger.value?.$el.focus();
}
async function finishManaging() {
    actions.clearSelection();
    managing.value = false;
    await nextTick();
    manageTrigger.value?.$el.focus();
}
watch(actions.confirmation, async (items) => {
    if (!items.length) {
        dialog.value?.close();
        confirmationText.value = '';
        await nextTick();
        if (actions.message.value) feedback.value?.focus();
    }
});
watch([actions.message, actions.busy], async ([value, busy]) => {
    if (value && !busy) {
        await nextTick();
        feedback.value?.focus();
    }
});
</script>

<style scoped>
.task-bulk-list,
.task-list {
    display: grid;
    min-inline-size: 0;
}
.task-bulk-list {
    gap: 1rem;
}
.bulk-toolbar,
.dialog-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
}
.bulk-toolbar p,
h2 {
    margin: 0;
}
.selection-note {
    margin: 0;
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.task-entry {
    min-inline-size: 0;
}
.task-entry.selecting {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: 1rem;
}
.task-select {
    display: flex;
    align-items: center;
    align-self: start;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    margin-block-start: 1rem;
    cursor: pointer;
}
.task-select input {
    margin: 0;
    accent-color: var(--scova-primary);
    cursor: inherit;
}
.task-select span {
    font-size: 0.875rem;
}
.task-select:has(input:disabled) {
    cursor: not-allowed;
}
.bulk-feedback,
.confirmation-body {
    overflow-wrap: anywhere;
}
.bulk-feedback:focus-visible,
.task-select:has(input:focus-visible) {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.125rem;
}
.danger,
.danger :deep(.n-button__content) {
    color: var(--scova-danger);
}
.danger :deep(.n-button__border),
.danger :deep(.n-button__state-border) {
    border-color: var(--scova-danger);
}
dialog {
    box-sizing: border-box;
    inline-size: min(38rem, calc(100% - 2rem));
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
dialog h2 {
    font-size: 1.25rem;
    overflow-wrap: anywhere;
}
.confirmation-body {
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
}
.confirmation-input {
    display: grid;
    gap: 0.5rem;
}
.confirmation-input input {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    min-block-size: 2.75rem;
    padding: 0.5rem;
    font: inherit;
    color: var(--scova-text);
    background: var(--scova-surface);
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.375rem;
}
dialog::backdrop {
    background: rgb(0 0 0 / 45%);
}
@media (max-width: 29.999rem) {
    .task-entry.selecting {
        column-gap: 0.5rem;
    }
    .task-select span {
        display: none;
    }
}
</style>
