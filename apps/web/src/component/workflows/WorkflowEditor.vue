<template>
    <section class="surface-card p-4 layout-grid gap-4" aria-labelledby="workflow-draft-heading">
        <h2 id="workflow-draft-heading" class="m-0">工作流草稿</h2>
        <state-panel v-if="!graph" state="error" message="此草稿无法在串行编辑器中打开。" />
        <form v-else class="layout-grid gap-4" method="post" @submit.prevent="save">
            <div class="layout-grid gap-2">
                <label for="workflow-draft-title">工作流名称</label>
                <input
                    id="workflow-draft-title"
                    v-model="title"
                    class="workflow-field"
                    name="title"
                    required
                    maxlength="160"
                    pattern=".*\S.*"
                    :disabled="busy"
                />
            </div>
            <fieldset class="layout-grid gap-2 min-w-0 m-0 p-0 border-none" :disabled="busy">
                <legend class="font-semibold p-0">节点顺序</legend>
                <p id="workflow-order-hint" class="my-2 text-muted">
                    拖动研究节点调整顺序，也可以使用检查器中的上移或下移按钮。
                </p>
                <div class="workflow-board">
                    <div class="workflow-rail">
                        <ol
                            class="workflow-steps"
                            role="list"
                            aria-describedby="workflow-order-hint"
                        >
                            <li class="workflow-step">
                                <span class="workflow-boundary">开始</span>
                            </li>
                            <li
                                v-for="(node, index) in studies"
                                :key="node.id"
                                class="workflow-step"
                                v-bind="{ 'data-node-id': node.id }"
                                @dragover="dragOver($event, node.id)"
                                @drop="drop($event, index)"
                            >
                                <button
                                    type="button"
                                    class="workflow-node"
                                    :class="{
                                        'drop-target': hovered === node.id && dragged !== node.id,
                                    }"
                                    :aria-pressed="selectedId === node.id"
                                    aria-controls="workflow-node-inspector"
                                    :draggable="!busy && studies.length > 1"
                                    @click="selectedId = node.id"
                                    @dragstart="beginDrag($event, node.id)"
                                    @dragend="clearDrag"
                                >
                                    <app-icon class="workflow-node-icon" name="workflows" />
                                    <span class="min-w-0">
                                        <span class="workflow-node-label"
                                            >研究 {{ index + 1 }}</span
                                        >
                                        <span
                                            class="workflow-node-task"
                                            :title="taskLabel(node.taskId)"
                                        >
                                            {{ taskLabel(node.taskId) }}
                                        </span>
                                    </span>
                                </button>
                            </li>
                            <li class="workflow-step">
                                <span class="workflow-boundary">结束</span>
                            </li>
                        </ol>
                        <button
                            ref="addButton"
                            type="button"
                            class="workflow-add"
                            :disabled="studies.length >= maxStudies"
                            @click="add"
                        >
                            <app-icon name="create" />
                            添加研究节点
                        </button>
                        <p v-if="studies.length >= maxStudies" class="m-0 text-muted">
                            已达到 {{ maxStudies }} 个研究节点上限。
                        </p>
                    </div>
                    <section
                        id="workflow-node-inspector"
                        ref="inspector"
                        class="workflow-inspector layout-grid gap-3"
                        aria-labelledby="workflow-inspector-heading"
                    >
                        <h3 id="workflow-inspector-heading" class="m-0">节点检查器</h3>
                        <template v-if="selectedStudy">
                            <div class="layout-grid gap-2">
                                <label for="workflow-selected-task"
                                    >研究 {{ selectedPosition }} 的任务</label
                                >
                                <select
                                    id="workflow-selected-task"
                                    ref="taskField"
                                    v-model="selectedStudy.taskId"
                                    class="workflow-field"
                                    required
                                >
                                    <option value="">选择任务</option>
                                    <option
                                        v-if="
                                            selectedStudy.taskId &&
                                            !tasksById.has(selectedStudy.taskId)
                                        "
                                        :value="selectedStudy.taskId"
                                    >
                                        已绑定任务（当前列表中不可见）
                                    </option>
                                    <option
                                        v-for="task in taskOptions"
                                        :key="task.id"
                                        :value="task.id"
                                    >
                                        {{ task.title }}
                                    </option>
                                </select>
                            </div>
                            <div v-if="tasksQuery.isPending.value" role="status" class="text-muted">
                                正在读取可用任务
                            </div>
                            <p
                                v-else-if="!taskOptions.length && !tasksQuery.isError.value"
                                class="m-0 text-muted"
                            >
                                暂无可选任务。<router-link
                                    class="internal-link"
                                    :to="{ name: 'task-create' }"
                                    >创建任务</router-link
                                >
                            </p>
                            <p v-if="tasksQuery.isError.value" role="alert" class="m-0">
                                {{ toApiError(tasksQuery.error.value).message }}
                            </p>
                            <action-button
                                v-if="tasksQuery.hasNextPage.value"
                                class="justify-self-start"
                                :busy="tasksQuery.isFetchingNextPage.value"
                                @click="tasksQuery.fetchNextPage()"
                                >{{
                                    tasksQuery.isFetchNextPageError.value
                                        ? '重试加载'
                                        : '加载更多可选任务'
                                }}</action-button
                            >
                            <action-button
                                v-else-if="tasksQuery.isError.value"
                                class="justify-self-start"
                                @click="tasksQuery.refetch()"
                                >重试读取任务</action-button
                            >
                            <div class="workflow-inspector-actions flex flex-wrap gap-2">
                                <action-button
                                    v-bind="{
                                        'data-move': 'up',
                                        'aria-label': `上移研究 ${selectedPosition}`,
                                    }"
                                    :disabled="selectedIndex === 0"
                                    @click="moveSelected('up')"
                                    >上移</action-button
                                >
                                <action-button
                                    v-bind="{
                                        'data-move': 'down',
                                        'aria-label': `下移研究 ${selectedPosition}`,
                                    }"
                                    :disabled="selectedPosition === studies.length"
                                    @click="moveSelected('down')"
                                    >下移</action-button
                                >
                                <action-button
                                    v-bind="{ 'aria-label': `删除研究 ${selectedPosition}` }"
                                    @click="removeSelected"
                                    >删除</action-button
                                >
                            </div>
                        </template>
                        <p v-else class="m-0 text-muted">
                            添加研究节点后，可以在此选择任务和调整顺序。
                        </p>
                    </section>
                </div>
            </fieldset>

            <p v-if="conflict" ref="errorSummary" tabindex="-1" class="m-0" role="alert">
                草稿已在其他位置更新。当前编辑仍保留，重新载入将采用服务端草稿。
            </p>
            <p v-else-if="problem" ref="errorSummary" tabindex="-1" class="m-0" role="alert">
                {{ problem }}
            </p>
            <p role="status" class="m-0 text-muted">
                {{ announcement || (dirty ? '有未保存的修改' : `草稿修订 ${revision}`) }}
            </p>
            <div class="flex flex-wrap gap-2">
                <action-button
                    type="primary"
                    attr-type="submit"
                    :busy="saveDraft.isPending.value"
                    :disabled="!dirty || conflict || publishDraft.isPending.value || reloading"
                    >保存草稿</action-button
                >
                <action-button
                    :busy="publishDraft.isPending.value"
                    :disabled="!canPublish || saveDraft.isPending.value || reloading"
                    @click="publish"
                    >发布版本</action-button
                >
                <action-button v-if="conflict" :busy="reloading" @click="reload"
                    >重新载入草稿</action-button
                >
            </div>
            <p v-if="!studies.length" class="m-0 text-muted">发布前请添加至少一个研究节点。</p>
        </form>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { workflowNodeLimit } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import { toApiError } from '@/api/errors';
import { shouldReportQueryError } from '@/api/query';
import {
    publishWorkflowEndpoint,
    updateWorkflowDraftEndpoint,
    workflowEndpoint,
    type WorkflowDetail,
    type WorkflowDraft,
} from '@/api/workflows';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';
import { useTasks } from '@/composable/useTasks';
import { readSerialGraph, serialGraph, type StudyNode } from '@/utils/workflow/serial';

const props = defineProps<{ snapshot: ApiResponse<WorkflowDetail> }>();
const lifecycle = useSessionLifecycle();
const { query: tasksQuery, items: taskItems } = useTasks('all', lifecycle);
const taskOptions = computed(() => taskItems.value.filter((task) => task.status !== 'archived'));
const tasksById = computed(() => new Map(taskOptions.value.map((task) => [task.id, task])));
const saveDraft = useSessionMutation(updateWorkflowDraftEndpoint, lifecycle);
const publishDraft = useSessionMutation(publishWorkflowEndpoint, lifecycle);
const lifetime = new AbortController();
onScopeDispose(() => lifetime.abort());

const baseline = shallowRef(props.snapshot);
const revision = computed(() => baseline.value.data.workflow.revision);
const graph = computed(() => readSerialGraph(baseline.value.data.draft));
const title = ref(baseline.value.data.workflow.title);
const studies = ref<StudyNode[]>(graph.value?.studies.map((node) => ({ ...node })) ?? []);
const selectedId = ref(studies.value[0]?.id);
const selectedIndex = computed(() =>
    studies.value.findIndex((node) => node.id === selectedId.value),
);
const selectedStudy = computed(() => studies.value[selectedIndex.value]);
const selectedPosition = computed(() => selectedIndex.value + 1);
const maxStudies = workflowNodeLimit - 2;
const dirty = computed(
    () =>
        title.value.trim() !== baseline.value.data.workflow.title ||
        JSON.stringify(studies.value) !== JSON.stringify(graph.value?.studies ?? []),
);
const conflict = ref(false);
const reloading = ref(false);
const writing = ref(false);
const busy = computed(() => writing.value || reloading.value);
const canPublish = computed(
    () =>
        !dirty.value &&
        !conflict.value &&
        studies.value.length > 0 &&
        baseline.value.data.publishedVersion?.draftRevision !== revision.value,
);
const problem = ref('');
const announcement = ref('');
const addButton = ref<HTMLButtonElement>();
const inspector = ref<HTMLElement>();
const taskField = ref<HTMLSelectElement>();
const errorSummary = ref<HTMLElement>();
const dragged = ref('');
const hovered = ref('');

function adopt(snapshot: ApiResponse<WorkflowDetail>) {
    baseline.value = snapshot;
    title.value = snapshot.data.workflow.title;
    studies.value = graph.value?.studies.map((node) => ({ ...node })) ?? [];
    if (!selectedStudy.value) selectedId.value = studies.value[0]?.id;
    conflict.value = false;
}

watch(
    () => props.snapshot,
    (snapshot) => {
        const changedRevision = snapshot.data.workflow.revision !== revision.value;
        const changedVersion =
            snapshot.data.publishedVersion?.id !== baseline.value.data.publishedVersion?.id;
        if (!changedRevision && !changedVersion) return;
        if (!dirty.value) adopt(snapshot);
        else if (changedRevision) conflict.value = true;
    },
);
watch(
    [title, studies],
    () => {
        announcement.value = '';
    },
    { deep: true, flush: 'sync' },
);

function taskLabel(taskId: string) {
    if (!taskId) return '未选择任务';
    return tasksById.value.get(taskId)?.title ?? '已绑定任务（当前列表中不可见）';
}

function focusTask() {
    void nextTick(() => taskField.value?.focus());
}

function add() {
    if (busy.value || studies.value.length >= maxStudies) return;
    const id = crypto.randomUUID();
    studies.value.push({ id, type: 'study', taskId: '' });
    selectedId.value = id;
    announcement.value = `已添加研究 ${studies.value.length}`;
    focusTask();
}

function removeSelected() {
    const index = selectedIndex.value;
    if (busy.value || index < 0) return;
    studies.value.splice(index, 1);
    announcement.value = `已删除研究 ${index + 1}`;
    selectedId.value = (studies.value[index] ?? studies.value.at(-1))?.id;
    if (selectedId.value) focusTask();
    else void nextTick(() => addButton.value?.focus());
}

function move(from: number, to: number) {
    const node = studies.value[from];
    if (busy.value || !node || from === to || to < 0 || to >= studies.value.length) return;
    studies.value = studies.value.toSpliced(from, 1).toSpliced(to, 0, node);
    announcement.value = `研究 ${from + 1} 已移到第 ${to + 1} 个位置`;
}

async function moveSelected(direction: 'up' | 'down') {
    const from = selectedIndex.value;
    const to = from + (direction === 'up' ? -1 : 1);
    move(from, to);
    if (from === selectedIndex.value) return;
    const next = to === 0 ? 'down' : to === studies.value.length - 1 ? 'up' : direction;
    await nextTick();
    inspector.value?.querySelector<HTMLButtonElement>(`[data-move="${next}"]`)?.focus();
}

function beginDrag(event: DragEvent, id: string) {
    if (!event.dataTransfer || busy.value || studies.value.length < 2) return;
    dragged.value = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
}

function dragOver(event: DragEvent, id: string) {
    if (!dragged.value || busy.value) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    hovered.value = id;
}

function clearDrag() {
    dragged.value = '';
    hovered.value = '';
}

function drop(event: DragEvent, index: number) {
    if (!dragged.value) return;
    event.preventDefault();
    move(
        studies.value.findIndex((node) => node.id === dragged.value),
        index,
    );
    clearDrag();
}

async function report(error: unknown) {
    if (!shouldReportQueryError(error)) return;
    const apiError = toApiError(error);
    if (apiError.status === 412) conflict.value = true;
    problem.value = apiError.message;
    await nextTick();
    errorSummary.value?.focus();
}

function snapshotOptions() {
    const workflowId = baseline.value.data.workflow.id;
    return lifecycle.queryOptions(workflowEndpoint, { params: { workflowId } }, [
        'workflows',
        workflowId,
        'detail',
    ]);
}

function accept(snapshot: ApiResponse<WorkflowDetail>) {
    adopt(snapshot);
    lifecycle.queryClient.setQueryData(snapshotOptions().queryKey, snapshot);
}

async function reload() {
    if (busy.value) return;
    const scope = lifecycle.capture();
    reloading.value = true;
    problem.value = '';
    try {
        const snapshot = await scope.request(
            workflowEndpoint,
            { params: { workflowId: baseline.value.data.workflow.id } },
            { signal: lifetime.signal },
        );
        if (scope.isCurrent() && !lifetime.signal.aborted) {
            accept(snapshot);
            announcement.value = '已重新载入草稿';
        }
    } catch (error) {
        if (scope.isCurrent() && !lifetime.signal.aborted) await report(error);
    } finally {
        reloading.value = false;
    }
}

async function save() {
    if (!graph.value || busy.value || !dirty.value || conflict.value) return;
    const unassigned = studies.value.find((node) => !node.taskId);
    if (unassigned) {
        selectedId.value = unassigned.id;
        await nextTick();
        taskField.value?.focus();
        taskField.value?.reportValidity();
        return;
    }
    const { start, end } = graph.value;
    await write('save', {
        title: title.value.trim(),
        graph: serialGraph(start, studies.value, end),
    });
}

async function publish() {
    if (busy.value || !canPublish.value) return;
    await write('publish');
}

async function write(action: 'save' | 'publish', body?: WorkflowDraft) {
    const scope = lifecycle.capture();
    const options = { ifMatch: baseline.value.headers.etag, signal: lifetime.signal };
    const params = { workflowId: baseline.value.data.workflow.id };
    problem.value = '';
    writing.value = true;
    try {
        if (!options.ifMatch) throw new Error('缺少草稿修订号，请重新载入工作流。');
        await lifecycle.queryClient.cancelQueries({
            queryKey: snapshotOptions().queryKey,
            exact: true,
        });
        if (!scope.isCurrent() || lifetime.signal.aborted) return;
        const snapshot = body
            ? await saveDraft.mutateAsync({ input: { params, body }, options })
            : await publishDraft.mutateAsync({ input: { params }, options });
        if (!scope.isCurrent() || lifetime.signal.aborted) return;
        accept(snapshot);
        if (action === 'save')
            void lifecycle.queryClient.invalidateQueries({
                queryKey: scope.queryKey(['workflows', 'list']),
            });
        announcement.value =
            action === 'save'
                ? '已保存草稿'
                : `已发布版本 ${snapshot.data.publishedVersion?.version ?? ''}`;
    } catch (error) {
        if (scope.isCurrent() && !lifetime.signal.aborted) await report(error);
    } finally {
        writing.value = false;
    }
}
</script>

<style scoped>
.workflow-field {
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 32rem;
    min-block-size: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
    color: inherit;
    font: inherit;
}

.workflow-field:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
}

.workflow-board,
.workflow-rail {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 1rem;
}

@media (min-width: 54rem) {
    .workflow-board {
        grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
    }
}

.workflow-rail {
    justify-items: center;
    text-align: center;
    background-color: var(--scova-canvas);
    background-image: radial-gradient(var(--scova-border) 0.7px, transparent 0.7px);
    background-size: 1rem 1rem;
    padding: clamp(0.75rem, 3vw, 1.5rem);
}

.workflow-rail,
.workflow-inspector {
    border: 1px solid var(--scova-border);
    border-radius: 0.75rem;
    overflow-wrap: anywhere;
}

.workflow-steps {
    --step-gap: 0.875rem;

    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--step-gap);
    inline-size: min(100%, 24rem);
    margin: 0;
    padding: 0;
    list-style: none;
}

.workflow-step {
    position: relative;
}

.workflow-step + .workflow-step::before {
    position: absolute;
    inset-block-end: 100%;
    inset-inline-start: calc(50% - 1px);
    block-size: var(--step-gap);
    inline-size: 2px;
    background: var(--scova-border);
    content: '';
}

.workflow-boundary {
    display: inline-block;
    padding: 0.25rem 0.875rem;
    border: 1px solid var(--scova-border);
    border-radius: 999px;
    background: var(--scova-surface);
    font-size: 0.875rem;
    font-weight: 600;
}

.workflow-node,
.workflow-add {
    min-block-size: 2.75rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.625rem;
    background: var(--scova-surface);
    color: inherit;
    font: inherit;
    cursor: pointer;
}

.workflow-node {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 0.625rem;
    inline-size: 100%;
    padding: 0.5rem 0.75rem;
    text-align: start;
}

.workflow-node-icon {
    display: grid;
    place-items: center;
    inline-size: 2rem;
    block-size: 2rem;
    border-radius: 0.5rem;
    background: var(--scova-selected);
    color: var(--scova-primary);
}

.workflow-node-label,
.workflow-node-task {
    display: block;
}

.workflow-node-label {
    color: var(--scova-muted);
    font-size: 0.8125rem;
}

.workflow-node-task {
    overflow: hidden;
    font-size: 0.9375rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.workflow-node[aria-pressed='true'] {
    border-color: var(--scova-primary);
    background: var(--scova-selected);
    box-shadow: inset 0 0 0 1px var(--scova-primary);
}

.workflow-node[draggable='true'] {
    cursor: grab;
}

.workflow-add {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    max-inline-size: 100%;
    padding: 0.375rem 0.75rem;
}

.workflow-node:enabled:hover,
.workflow-add:enabled:hover {
    border-color: var(--scova-primary);
}

.workflow-node:focus-visible,
.workflow-add:focus-visible {
    outline: 2px solid var(--scova-primary);
    outline-offset: 2px;
}

.workflow-node:disabled,
.workflow-add:disabled {
    color: var(--scova-muted);
    cursor: not-allowed;
}

.workflow-node.drop-target {
    outline: 2px dashed var(--scova-primary);
    outline-offset: 2px;
}

.workflow-inspector {
    min-inline-size: 0;
    padding: 1rem;
}

.workflow-inspector-actions {
    padding-block-start: 0.75rem;
    border-block-start: 1px solid var(--scova-border);
}
</style>
