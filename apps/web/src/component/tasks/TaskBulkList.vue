<template>
    <div class="task-bulk-list layout-stack">
        <div
            v-if="tasks.length || managing"
            class="bulk-toolbar action-row justify-between gap-y-4 [@media(max-width:_47.999rem)]:items-start"
        >
            <action-button
                v-if="!managing"
                ref="manageTrigger"
                quaternary
                :disabled="unavailable"
                @click="managing = true"
                ><app-icon name="tasks" />批量管理</action-button
            >
            <template v-else>
                <div
                    class="bulk-selection flex flex-wrap items-center gap-2 min-w-0 [@media(max-width:_47.999rem)]:[flex:1_1_100%]"
                >
                    <p
                        class="selection-count [flex:0_0_auto] text-[0.875rem] font-semibold text-muted [@media(max-width:_47.999rem)]:[flex-basis:100%] [.bulk-toolbar_&:is(p)]:m-0"
                    >
                        已选 {{ actions.selected.value.length }} 个任务
                    </p>
                    <div class="selection-actions flex flex-wrap items-center gap-2 min-w-0">
                        <action-button
                            :disabled="locked || !tasks.length"
                            @click="actions.selectLoaded()"
                            quaternary
                            >选择已加载任务</action-button
                        >
                        <action-button
                            :disabled="locked || !actions.selected.value.length"
                            quaternary
                            @click="actions.clearSelection()"
                            >取消选择</action-button
                        >
                    </div>
                </div>
                <div
                    class="bulk-actions flex flex-wrap items-center gap-2 min-w-0 ml-auto [@media(max-width:_47.999rem)]:([flex:1_1_100%] ml-0)"
                >
                    <action-button
                        ref="finishTrigger"
                        quaternary
                        :disabled="actions.busy.value"
                        @click="finishManaging"
                        >退出批量管理</action-button
                    >
                    <action-button
                        ref="clearTrigger"
                        class="danger danger-action"
                        :disabled="
                            unavailable || actions.pending.value || !actions.selected.value.length
                        "
                        :busy="actions.preparing.value"
                        @click="openConfirmation"
                        ><app-icon name="delete" />清除所选任务</action-button
                    >
                </div>
            </template>
        </div>
        <p v-if="managing" class="selection-note text-muted text-[0.875rem] m-0">
            仅选择当前筛选下已加载的任务，每批最多
            {{ bulkTaskLimit }}
            个；加载更多不会自动选中。启用状态不代表正在执行，清除时会检查活动执行。
        </p>
        <div
            v-if="failedResults.length"
            ref="feedback"
            class="bulk-feedback break-anywhere focus-visible:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem])"
            role="status"
            tabindex="-1"
        >
            <ul v-if="failedResults.length">
                <li v-for="result in failedResults" :key="result.id">
                    {{ result.title }}：{{ result.message }}
                </li>
            </ul>
        </div>
        <div class="task-list layout-grid">
            <div
                v-for="task in tasks"
                :key="task.id"
                class="task-entry min-w-0 [&.task-entry.selecting]:(grid grid-cols-[auto_minmax(0,_1fr)] gap-x-4) [@media(max-width:_29.999rem)]:[&.task-entry.selecting]:gap-x-2"
                :class="{ selecting: managing }"
            >
                <label
                    v-if="managing"
                    class="task-select flex items-center [align-self:start] gap-2 min-h-11 mt-4 cursor-pointer [&.task-select:has(input:disabled)]:cursor-not-allowed [&.task-select:has(input:focus-visible)]:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem])"
                >
                    <input
                        class="[.task-select_&:is(input)]:([accent-color:var(--scova-primary)] cursor-inherit m-0) [.confirmation-input_&:is(input)]:(box-border w-full min-w-0 min-h-11 [font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit] leading-[inherit] [font-variant:inherit] text-default bg-surface border-theme rounded-1.5 p-2)"
                        type="checkbox"
                        :aria-label="`选择任务：${task.title}`"
                        :checked="isSelected(task.id)"
                        :disabled="
                            locked ||
                            (!isSelected(task.id) && actions.selected.value.length >= bulkTaskLimit)
                        "
                        @change="actions.toggle(task)"
                    />
                    <span
                        class="[.task-select_&:is(span)]:text-[0.875rem] [@media(max-width:_29.999rem)]:[.task-select_&:is(span)]:hidden"
                        >选择</span
                    >
                </label>
                <task-card :task="task" :filter="filter" :timezone="timezone" />
            </div>
        </div>
        <dialog
            class="box-border w-[min(38rem,_calc(100%_-_2rem))] max-h-[calc(100dvh_-_2rem)] border-theme rounded-3 text-default bg-surface overflow-hidden p-[clamp(1rem,_4%,_2rem)] [&:is(dialog)[open]]:(grid grid-rows-[auto_minmax(0,_1fr)_auto] gap-6) [&:is(dialog)::backdrop]:[background:rgb(0_0_0_/_45%)]"
            ref="dialog"
            aria-labelledby="bulk-delete-title"
            aria-describedby="bulk-delete-consequence"
            @cancel.prevent="cancel"
        >
            <h2
                class="m-0 [dialog_&:is(h2)]:(text-[1.25rem] break-anywhere)"
                id="bulk-delete-title"
            >
                永久清除 {{ actions.confirmation.value.length }} 个任务？
            </h2>
            <div
                class="confirmation-body break-anywhere min-h-0 overflow-auto [overscroll-behavior:contain]"
            >
                <p id="bulk-delete-consequence">
                    将永久删除以下任务及其配置版本、执行历史、报告、通知、报告笔记和问答，无法恢复。共享来源、网页快照和来源收藏保留。有活动执行或修订变化的任务不会被清除。
                </p>
                <ul>
                    <li v-for="item in actions.confirmation.value" :key="item.data.task.id">
                        {{ item.data.task.title }}
                    </li>
                </ul>
                <label class="confirmation-input grid gap-2"
                    >请输入“{{ actions.phrase.value }}”以确认
                    <input
                        class="[.confirmation-input_&:is(input)]:(box-border w-full min-w-0 min-h-11 [font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit] leading-[inherit] [font-variant:inherit] text-default bg-surface border-theme rounded-1.5 p-2)"
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
            <div class="dialog-actions action-row">
                <action-button ref="cancelTrigger" :disabled="actions.pending.value" @click="cancel"
                    >取消</action-button
                >
                <action-button
                    class="danger danger-action"
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
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import TaskCard from '@/component/tasks/TaskCard.vue';
import { bulkTaskLimit, useBulkTaskDeletion } from '@/composable/useBulkTaskDeletion';
import { useActionNotification } from '@/composable/useActionNotification';
import type { TaskFilter } from '@/composable/useTasks';
const props = defineProps<{
    tasks: Task[];
    filter: TaskFilter;
    timezone: string;
    unavailable: boolean;
}>();
const actions = useBulkTaskDeletion(() => props.tasks);
const notification = useActionNotification();
notification.watch(actions.message, 'warning');
watch(actions.pending, (pending, wasPending) => {
    if (pending || !wasPending || !actions.results.value.length) return;
    const removed = actions.results.value.filter((result) => result.status === 'removed').length;
    const remaining = actions.results.value.length - removed;
    if (remaining)
        notification.warning(
            `已清除 ${removed} 个任务，${remaining} 个需处理`,
            '请查看未完成项并核对后重新选择。',
        );
    else notification.success(`已清除 ${removed} 个任务`);
});
const failedResults = computed(() =>
    actions.results.value.filter((result) => result.status !== 'removed'),
);
const managing = ref(false);
const confirmationText = ref('');
const dialog = ref<HTMLDialogElement>();
const cancelTrigger = ref<{ $el: HTMLButtonElement }>();
const clearTrigger = ref<{ $el: HTMLButtonElement }>();
const manageTrigger = ref<{ $el: HTMLButtonElement }>();
const finishTrigger = ref<{ $el: HTMLButtonElement }>();
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
        if (failedResults.value.length) feedback.value?.focus();
        else if (actions.results.value.length) finishTrigger.value?.$el.focus();
    }
});
watch([actions.busy, failedResults], async ([busy, failures]) => {
    if (failures.length && !busy) {
        await nextTick();
        feedback.value?.focus();
    }
});
</script>
