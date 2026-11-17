<template>
    <section
        ref="root"
        tabindex="-1"
        class="task-lifecycle scova-surface layout-stack rounded-3 break-anywhere p-[clamp(1rem,_3%,_2rem)] [&.task-lifecycle_>_.scova-action-button]:justify-self-start"
        aria-labelledby="task-lifecycle-title"
    >
        <h2
            class="text-[1.25rem] leading-[1.5] m-0 [dialog_&:is(h2)]:m-0"
            id="task-lifecycle-title"
        >
            任务管理
        </h2>
        <template v-if="actions.snapshot.value">
            <p class="[dialog_&:is(p)]:m-0">
                当前状态：{{ statusLabels[actions.snapshot.value.data.task.status] }}
            </p>
            <p
                class="[dialog_&:is(p)]:m-0"
                v-if="actions.snapshot.value.data.task.status === 'archived'"
            >
                任务已归档，不能恢复或启动新执行。已有报告与历史保留。
            </p>
            <template v-else>
                <p
                    class="[dialog_&:is(p)]:m-0"
                    v-if="actions.snapshot.value.data.task.status === 'active'"
                >
                    暂停只停止未来计划，在途执行继续，仍可显式手动执行。
                </p>
                <p class="[dialog_&:is(p)]:m-0" v-else>
                    恢复只重新安排未来计划，不补跑暂停期间的历史时点。
                </p>
                <p class="[dialog_&:is(p)]:m-0" v-if="actions.snapshot.value.data.task.nextRunAt">
                    下次计划：<time :datetime="actions.snapshot.value.data.task.nextRunAt">{{
                        time(actions.snapshot.value.data.task.nextRunAt)
                    }}</time
                    >（任务时区 {{ actions.snapshot.value.data.version.config.timezone }}）
                </p>
                <p
                    class="[dialog_&:is(p)]:m-0"
                    v-else-if="
                        actions.snapshot.value.data.version.config.schedule.frequency === 'manual'
                    "
                >
                    该任务仅手动执行，没有周期计划。
                </p>
            </template>
        </template>
        <p class="[dialog_&:is(p)]:m-0" v-else>
            {{ actions.refreshing.value ? '正在读取任务状态' : '任务状态暂不可用' }}
        </p>
        <div class="lifecycle-buttons action-group items-center">
            <template
                v-if="
                    actions.snapshot.value && actions.snapshot.value.data.task.status !== 'archived'
                "
            >
                <action-button
                    v-if="actions.snapshot.value.data.task.status === 'active'"
                    :disabled="actions.disabled.value && !actions.pending.value"
                    :busy="actions.pending.value"
                    @click="submit('pause')"
                    ><app-icon name="pause" />暂停未来计划</action-button
                >
                <action-button
                    v-else
                    :disabled="actions.disabled.value && !actions.pending.value"
                    :busy="actions.pending.value"
                    @click="submit('resume')"
                    ><app-icon name="run" />恢复未来计划</action-button
                >
            </template>
            <action-button
                :disabled="actions.pending.value"
                :busy="actions.refreshing.value"
                @click="actions.refresh()"
                ><app-icon name="retry" />刷新任务状态</action-button
            >
            <div v-if="actions.snapshot.value" class="action-group ml-auto">
                <action-button
                    v-if="actions.snapshot.value.data.task.status !== 'archived'"
                    ref="archiveTrigger"
                    class="danger danger-action"
                    :disabled="actions.disabled.value"
                    @click="openArchive"
                    ><app-icon name="archive" />归档任务</action-button
                >
                <action-button
                    ref="deleteTrigger"
                    class="danger danger-action"
                    :disabled="actions.disabled.value"
                    @click="openDelete"
                >
                    <app-icon name="delete" />清除任务
                </action-button>
            </div>
        </div>
        <dialog
            class="box-border w-[min(34rem,_calc(100%_-_2rem))] max-h-[calc(100dvh_-_2rem)] border-theme rounded-3 text-default bg-surface overflow-hidden p-[clamp(1rem,_4%,_2rem)] [&:is(dialog)[open]]:(grid grid-rows-[auto_minmax(0,_1fr)_auto] gap-6) [&:is(dialog)::backdrop]:[background:rgb(0_0_0_/_45%)]"
            ref="confirmationDialog"
            aria-labelledby="archive-title"
            aria-describedby="archive-consequence"
            @cancel.prevent="cancelArchive"
        >
            <h2 class="text-[1.25rem] leading-[1.5] m-0 [dialog_&:is(h2)]:m-0" id="archive-title">
                归档任务？
            </h2>
            <p
                class="[dialog_&:is(p)]:m-0 min-h-0 overflow-auto [overscroll-behavior:contain] keyboard-focus-inset"
                id="archive-consequence"
                tabindex="0"
            >
                归档将停止未来计划、阻止新执行，并对活动执行请求取消；取消完成前仍可能有在途工作。配置版本、报告与历史会保留。归档后不能恢复任务。
            </p>
            <div class="lifecycle-buttons action-group">
                <action-button ref="cancelTrigger" @click="cancelArchive">取消</action-button>
                <action-button
                    class="danger danger-action"
                    :busy="actions.pending.value"
                    :disabled="!actions.confirmation.value"
                    @click="confirmArchive"
                    ><app-icon name="archive" />确认归档</action-button
                >
            </div>
        </dialog>
        <dialog
            class="box-border w-[min(34rem,_calc(100%_-_2rem))] max-h-[calc(100dvh_-_2rem)] border-theme rounded-3 text-default bg-surface overflow-hidden p-[clamp(1rem,_4%,_2rem)] [&:is(dialog)[open]]:(grid grid-rows-[auto_minmax(0,_1fr)_auto] gap-6) [&:is(dialog)::backdrop]:[background:rgb(0_0_0_/_45%)]"
            ref="deleteDialog"
            aria-labelledby="delete-task-title"
            aria-describedby="delete-task-consequence"
            @cancel.prevent="cancelDelete"
        >
            <h2
                class="text-[1.25rem] leading-[1.5] m-0 [dialog_&:is(h2)]:m-0"
                id="delete-task-title"
            >
                永久清除任务？
            </h2>
            <div
                id="delete-task-consequence"
                class="delete-consequence min-h-0 overflow-auto [overscroll-behavior:contain]"
                tabindex="0"
            >
                <p class="[dialog_&:is(p)]:m-0">
                    将永久删除“{{
                        actions.confirmation.value?.data.task.title
                    }}”及其配置版本、执行历史、报告、通知、报告笔记和问答，无法恢复。
                </p>
                <p class="[dialog_&:is(p)]:m-0">
                    共享来源、网页快照和来源收藏保留。仍有活动执行时，请先取消并等待结束后再清除。
                </p>
            </div>
            <div class="lifecycle-buttons action-group">
                <action-button ref="deleteCancel" @click="cancelDelete">取消</action-button>
                <action-button
                    class="danger danger-action"
                    :busy="actions.pending.value"
                    :disabled="!actions.confirmation.value"
                    @click="confirmDelete"
                    >确认永久清除</action-button
                >
            </div>
        </dialog>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { TaskLifecycleAction } from '@/api/task-lifecycle';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useTaskLifecycle } from '@/composables/useTaskLifecycle';
import { useActionNotification } from '@/composables/useActionNotification';
const props = defineProps<{ taskId: string }>();
const actions = useTaskLifecycle(() => props.taskId);
const root = ref<HTMLElement>();
async function submit(action: TaskLifecycleAction) {
    const hadFocus = root.value?.contains(document.activeElement);
    await actions.submit(action);
    await nextTick();
    if (hadFocus && document.activeElement === document.body && root.value?.isConnected) {
        (root.value.querySelector<HTMLElement>('button:not(:disabled)') ?? root.value).focus();
    }
}
useActionNotification().watch(actions.message, () => (actions.blocked.value ? 'warning' : 'info'));
const router = useRouter();
const deleteDialog = ref<HTMLDialogElement>();
const deleteTrigger = ref<{ $el: HTMLButtonElement }>();
const deleteCancel = ref<{ $el: HTMLButtonElement }>();
async function openDelete() {
    if (!actions.prepareDelete()) return;
    deleteDialog.value?.showModal();
    await nextTick();
    deleteCancel.value?.$el.focus();
}
async function cancelDelete() {
    deleteDialog.value?.close();
    actions.cancelArchive();
    await nextTick();
    deleteTrigger.value?.$el.focus();
}
async function confirmDelete() {
    deleteDialog.value?.close();
    if (await actions.remove()) await router.replace({ name: 'tasks' });
}
const statusLabels = { active: '已启用', paused: '已暂停', archived: '已归档' };
const confirmationDialog = ref<HTMLDialogElement>();
const archiveTrigger = ref<{ $el: HTMLButtonElement }>();
const cancelTrigger = ref<{ $el: HTMLButtonElement }>();
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
    await submit('archive');
}
watch(actions.confirmation, (value) => {
    if (!value) {
        confirmationDialog.value?.close();
        deleteDialog.value?.close();
    }
});
</script>
