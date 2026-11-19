<template>
    <section
        ref="panel"
        class="notes-panel layout-grid gap-6 break-anywhere w-full min-w-0 keyboard-focus-wide"
        :style="reading.variables"
        :aria-labelledby="`${id}-title`"
        tabindex="-1"
    >
        <h2
            :id="`${id}-title`"
            class="scova-interface flex items-center gap-2 text-[1.25rem] font-semibold m-0"
        >
            <app-icon name="edit" />纯文本笔记
        </h2>
        <p v-if="!available" class="scova-interface m-0" role="status">
            报告暂时不可用；本地稿仍保留，可复制。恢复读取前不能新建、保存、删除或重放。
        </p>
        <div
            v-if="
                available &&
                (!allowAll ||
                    currentTarget ||
                    !query.isSuccess.value ||
                    items.length ||
                    previous.length)
            "
            class="notes-tools scova-interface report-grid"
        >
            <label :for="`${id}-target`">笔记目标</label>
            <select
                class="box-border w-full min-w-0 min-h-11 border-theme rounded-2 bg-surface text-default font-inherit cursor-pointer p-2.5 keyboard-focus-wide disabled:cursor-not-allowed"
                :id="`${id}-target`"
                :value="selection"
                :disabled="editor.pending.value || editor.reading.value"
                @change="changeTarget"
            >
                <option v-if="allowAll" value="">全部笔记</option>
                <option
                    v-for="item in targets"
                    :key="noteTargetKey(item)"
                    :value="noteTargetKey(item)"
                >
                    {{ item.label }}
                </option>
            </select>
            <div class="notes-actions action-group items-start">
                <action-button
                    :disabled="!currentTarget || editor.pending.value || editor.reading.value"
                    @click="begin"
                    >新建笔记</action-button
                >
                <action-button
                    :disabled="query.isFetching.value || editor.pending.value"
                    @click="reload"
                    >重新读取本页</action-button
                >
                <action-button
                    :disabled="query.isFetching.value || editor.pending.value"
                    @click="firstPage"
                    >从第一页重新读取</action-button
                >
            </div>
        </div>
        <note-editor :state="editor" :available="available" @close="closeEditor" />
        <template v-if="available">
            <p v-if="query.isPending.value" class="scova-interface m-0" role="status">
                正在读取笔记。
            </p>
            <p v-if="query.isError.value" class="scova-interface m-0" role="alert">
                {{ noteReadError(query.error.value) }}
            </p>
            <p v-if="query.isError.value && items.length" class="scova-interface m-0">
                以下保留上次读取值，请重新读取以确认。
            </p>
            <state-panel
                v-if="query.isSuccess.value && !items.length"
                state="empty"
                icon="edit"
                message="暂无笔记"
            />
            <ul class="notes-list list-none min-w-0 m-0 p-0">
                <li
                    v-for="note in items"
                    :key="note.id"
                    class="note-entry layout-grid gap-2.5 break-anywhere pt-6 pb-6 [border-bottom:0.0625rem_solid_var(--scova-border)]"
                >
                    <p class="note-body scova-note whitespace-pre-wrap m-0">{{ note.body }}</p>
                    <p class="note-target scova-interface text-muted text-[0.875rem] m-0">
                        {{ targetLabel(note) }}
                    </p>
                    <div class="notes-actions scova-interface action-group items-start">
                        <details
                            class="note-details min-w-0 max-w-full [&.note-details[open]]:[flex-basis:100%]"
                        >
                            <summary
                                class="min-h-11 pt-2.5 pb-2.5 box-border cursor-pointer text-muted keyboard-focus-wide"
                            >
                                笔记详情
                            </summary>
                            <dl class="flex flex-wrap gap-[1rem_2rem] m-0">
                                <div>
                                    <dt class="text-muted">
                                        {{ note.target.kind === 'report' ? '报告' : '来源' }}目标
                                    </dt>
                                    <dd class="m-0">{{ note.target.id }}</dd>
                                </div>
                                <div>
                                    <dt class="text-muted">最近编辑</dt>
                                    <dd class="m-0">
                                        <time :datetime="note.updatedAt">{{ note.updatedAt }}</time>
                                    </dd>
                                </div>
                            </dl>
                        </details>
                        <action-button
                            :disabled="editor.pending.value || editor.reading.value"
                            @click="open(note)"
                            >编辑笔记</action-button
                        >
                        <router-link
                            class="inline-flex items-center min-h-11 internal-link cursor-pointer keyboard-focus-wide"
                            v-if="note.target.kind === 'report'"
                            :to="`/reports/${note.target.id}`"
                            >打开关联报告</router-link
                        >
                    </div>
                </li>
            </ul>
            <nav
                class="notes-actions scova-interface action-group items-start"
                aria-label="笔记分页"
            >
                <action-button
                    v-if="previous.length"
                    :disabled="query.isFetching.value || editor.pending.value"
                    @click="turn(false)"
                    >上一页笔记</action-button
                >
                <action-button
                    v-if="query.data.value?.data.nextCursor"
                    :disabled="
                        query.isFetching.value || query.isError.value || editor.pending.value
                    "
                    @click="turn(true)"
                    >下一页笔记</action-button
                >
            </nav>
        </template>
    </section>
</template>

<script setup lang="ts">
import AppIcon from '@/component/common/AppIcon.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { RouterLink, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import type { LibraryTarget } from '@scova/models';
import type { Note, NoteTarget } from '@/api/notes';
import ActionButton from '@/component/common/ActionButton.vue';
import NoteEditor from '@/component/library/NoteEditor.vue';
import { useNoteEditor, useNotes } from '@/composable/useNotes';
import { useReadingTypography } from '@/composable/useReadingTypography';
import { noteReadError, noteTargetKey } from '@/utils/notes';
const props = withDefaults(
    defineProps<{
        targets: NoteTarget[];
        initialTarget?: LibraryTarget;
        allowAll?: boolean;
        active?: boolean;
        available?: boolean;
    }>(),
    { allowAll: false, active: true, available: true },
);
const id = useId();
const panel = ref<HTMLElement>();
const selection = ref(props.initialTarget ? noteTargetKey(props.initialTarget) : '');
const currentTarget = computed(() =>
    props.targets.find((item) => noteTargetKey(item) === selection.value),
);
const { reading } = useReadingTypography();
const editor = useNoteEditor(undefined, () => props.available);
const { query, items, previous, next, back, first } = useNotes(
    () => currentTarget.value,
    () => props.active && props.available,
);
const canLeave = () => editor.canLeave((message) => window.confirm(message));
function leave() {
    if (!canLeave()) return false;
    editor.clear();
    return true;
}
function selectTarget(value: LibraryTarget) {
    const key = noteTargetKey(value);
    if (!props.available || !props.targets.some((item) => noteTargetKey(item) === key) || !leave())
        return false;
    selection.value = key;
    return true;
}
defineExpose({ canLeave, leave, selectTarget });
watch(
    () => props.initialTarget && noteTargetKey(props.initialTarget),
    (key) => {
        if (key === selection.value || !canLeave()) return;
        editor.clear();
        selection.value = key ?? '';
    },
);
async function focusPanel() {
    await nextTick();
    panel.value?.focus();
}
function changeTarget(event: Event) {
    const input = event.target as HTMLSelectElement;
    if (canLeave()) {
        editor.clear();
        selection.value = input.value;
    } else input.value = selection.value;
}
function begin() {
    if (currentTarget.value && canLeave()) {
        editor.begin(currentTarget.value);
        void nextTick(() => panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus());
    }
}
async function open(note: Note) {
    if (!canLeave()) return;
    await editor.open(note);
    if (editor.mode.value !== 'closed')
        await nextTick(() => panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus());
}
function closeEditor() {
    if (canLeave()) {
        editor.clear();
        void focusPanel();
    }
}
async function reload() {
    if (!canLeave()) return;
    editor.clear();
    await query.refetch();
}
async function firstPage() {
    if (!canLeave()) return;
    editor.clear();
    await first();
    await focusPanel();
}
function turn(forward: boolean) {
    if (!canLeave()) return;
    editor.clear();
    if (forward) next();
    else back();
    void focusPanel();
}
function targetLabel(note: Note) {
    const match = props.targets.find((item) => noteTargetKey(item) === noteTargetKey(note.target));
    return match?.label ?? note.target.id;
}
function beforeUnload(event: BeforeUnloadEvent) {
    if (editor.protectedState.value) {
        event.preventDefault();
        event.returnValue = '';
    }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
onBeforeRouteLeave(canLeave);
onBeforeRouteUpdate(canLeave);
</script>
