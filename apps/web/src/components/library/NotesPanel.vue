<template>
    <section
        ref="panel"
        class="notes-panel"
        :style="reading.variables"
        :aria-labelledby="`${id}-title`"
        tabindex="-1"
    >
        <h2 :id="`${id}-title`" class="scova-interface"><app-icon name="edit" />纯文本笔记</h2>
        <p v-if="!available" class="scova-interface" role="status">
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
            class="notes-tools scova-interface"
        >
            <label :for="`${id}-target`">笔记目标</label>
            <select
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
            <div class="notes-actions">
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
            <p v-if="query.isPending.value" class="scova-interface" role="status">正在读取笔记。</p>
            <p v-if="query.isError.value" class="scova-interface" role="alert">
                {{ noteReadError(query.error.value) }}
            </p>
            <p v-if="query.isError.value && items.length" class="scova-interface">
                以下保留上次读取值，请重新读取以确认。
            </p>
            <p
                v-if="query.isSuccess.value && !items.length"
                class="scova-interface empty-copy"
                role="status"
            >
                暂无笔记
            </p>
            <ul class="notes-list">
                <li v-for="note in items" :key="note.id" class="note-entry">
                    <p class="note-body scova-note">{{ note.body }}</p>
                    <p class="note-target scova-interface">{{ targetLabel(note) }}</p>
                    <div class="notes-actions scova-interface">
                        <details class="note-details">
                            <summary>笔记详情</summary>
                            <dl>
                                <div>
                                    <dt>
                                        {{ note.target.kind === 'report' ? '报告' : '来源' }}目标
                                    </dt>
                                    <dd>{{ note.target.id }}</dd>
                                </div>
                                <div>
                                    <dt>最近编辑</dt>
                                    <dd>
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
                            v-if="note.target.kind === 'report'"
                            :to="`/reports/${note.target.id}`"
                            >打开关联报告</router-link
                        >
                    </div>
                </li>
            </ul>
            <nav class="notes-actions scova-interface" aria-label="笔记分页">
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
import AppIcon from '@/components/common/AppIcon.vue';
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { RouterLink, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import type { LibraryTarget } from '@scova/models';
import type { Note, NoteTarget } from '@/api/notes';
import ActionButton from '@/components/common/ActionButton.vue';
import NoteEditor from '@/components/library/NoteEditor.vue';
import { useNoteEditor, useNotes } from '@/composables/useNotes';
import { useReadingTypography } from '@/composables/useReadingTypography';
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

<style scoped>
h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.notes-panel,
.notes-tools,
.note-entry {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.note-target {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.note-details {
    min-inline-size: 0;
    max-inline-size: 100%;
}
.note-details[open] {
    flex-basis: 100%;
}
summary {
    min-block-size: 2.75rem;
    padding-block: 0.625rem;
    box-sizing: border-box;
    cursor: pointer;
    color: var(--scova-muted);
}
summary:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.notes-panel {
    inline-size: min(100%, 45rem);
    gap: 1.5rem;
}
h2,
p {
    margin: 0;
}
h2.scova-interface {
    font-size: 1.25rem;
    font-weight: 600;
}
select {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    min-block-size: 2.75rem;
    padding: 0.625rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    font: inherit;
    cursor: pointer;
}
select:disabled {
    cursor: not-allowed;
}
.notes-list {
    list-style: none;
    padding: 0;
    margin: 0;
    min-inline-size: 0;
}
.note-entry {
    padding-block: 1.5rem;
    gap: 0.625rem;
    border-block-end: 0.0625rem solid var(--scova-border);
}
.note-body {
    white-space: pre-wrap;
}
dl {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0;
}
.notes-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    gap: 0.75rem;
}
a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
a:focus-visible,
select:focus-visible,
.notes-panel:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
