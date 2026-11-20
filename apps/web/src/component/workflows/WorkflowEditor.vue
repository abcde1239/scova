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
                    拖动研究节点调整顺序，也可以使用上移或下移按钮。
                </p>
                <ol
                    ref="nodeList"
                    class="layout-grid gap-2 m-0 p-0 list-none"
                    aria-describedby="workflow-order-hint"
                >
                    <li class="workflow-node font-semibold">开始</li>
                    <li
                        v-for="(node, index) in studies"
                        :key="node.id"
                        class="workflow-node layout-grid gap-2"
                        v-bind="{ 'data-node-id': node.id }"
                        :class="{ 'drop-target': hovered === node.id && dragged !== node.id }"
                        @dragover="dragOver($event, node.id)"
                        @drop="drop($event, index)"
                    >
                        <div
                            class="font-semibold grab-handle"
                            :draggable="!busy && studies.length > 1"
                            @dragstart="beginDrag($event, node.id)"
                            @dragend="clearDrag"
                        >
                            研究 {{ index + 1 }}
                        </div>
                        <label :for="`workflow-task-${node.id}`">研究 {{ index + 1 }} 的任务</label>
                        <select
                            :id="`workflow-task-${node.id}`"
                            v-model="node.taskId"
                            class="workflow-field"
                            required
                        >
                            <option value="">选择任务</option>
                            <option
                                v-if="
                                    node.taskId &&
                                    !taskOptions.some((task) => task.id === node.taskId)
                                "
                                :value="node.taskId"
                            >
                                已绑定任务（当前列表中不可见）
                            </option>
                            <option v-for="task in taskOptions" :key="task.id" :value="task.id">
                                {{ task.title }}
                            </option>
                        </select>
                        <div class="flex flex-wrap gap-2">
                            <action-button
                                v-bind="{
                                    'data-move': 'up',
                                    'aria-label': `上移研究 ${index + 1}`,
                                }"
                                :disabled="index === 0"
                                @click="move(index, index - 1, 'up')"
                                >上移</action-button
                            >
                            <action-button
                                v-bind="{
                                    'data-move': 'down',
                                    'aria-label': `下移研究 ${index + 1}`,
                                }"
                                :disabled="index === studies.length - 1"
                                @click="move(index, index + 1, 'down')"
                                >下移</action-button
                            >
                            <action-button
                                v-bind="{ 'aria-label': `删除研究 ${index + 1}` }"
                                @click="remove(index)"
                                >删除</action-button
                            >
                        </div>
                    </li>
                    <li class="workflow-node font-semibold">结束</li>
                </ol>
                <div v-if="tasksQuery.isPending.value" role="status" class="text-muted">
                    正在读取可用任务
                </div>
                <p
                    v-else-if="!taskItems.length && !tasksQuery.isError.value"
                    class="m-0 text-muted"
                >
                    暂无可选任务。<router-link class="internal-link" :to="{ name: 'task-create' }"
                        >创建任务</router-link
                    >
                </p>
                <p v-if="tasksQuery.isError.value" role="alert" class="m-0">
                    {{ toApiError(tasksQuery.error.value).message }}
                </p>
                <div class="flex flex-wrap gap-2">
                    <action-button
                        v-bind="{ id: 'workflow-add-node' }"
                        :disabled="studies.length >= maxStudies"
                        @click="add"
                        >添加研究节点</action-button
                    >
                    <action-button
                        v-if="tasksQuery.hasNextPage.value"
                        :busy="tasksQuery.isFetchingNextPage.value"
                        @click="tasksQuery.fetchNextPage()"
                        >{{
                            tasksQuery.isFetchNextPageError.value ? '重试加载' : '加载更多可选任务'
                        }}</action-button
                    >
                    <action-button
                        v-else-if="tasksQuery.isError.value"
                        @click="tasksQuery.refetch()"
                        >重试读取任务</action-button
                    >
                </div>
                <p v-if="studies.length >= maxStudies" class="m-0 text-muted">
                    已达到 {{ maxStudies }} 个研究节点上限。
                </p>
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
import StatePanel from '@/component/common/StatePanel.vue';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';
import { useTasks } from '@/composable/useTasks';
import { readSerialGraph, serialGraph, type StudyNode } from '@/utils/workflow/serial';

const props = defineProps<{ snapshot: ApiResponse<WorkflowDetail> }>();
const lifecycle = useSessionLifecycle();
const { query: tasksQuery, items: taskItems } = useTasks('all', lifecycle);
const taskOptions = computed(() => taskItems.value.filter((task) => task.status !== 'archived'));
const saveDraft = useSessionMutation(updateWorkflowDraftEndpoint, lifecycle);
const publishDraft = useSessionMutation(publishWorkflowEndpoint, lifecycle);
const lifetime = new AbortController();
onScopeDispose(() => lifetime.abort());

const baseline = shallowRef(props.snapshot);
const revision = computed(() => baseline.value.data.workflow.revision);
const graph = computed(() => readSerialGraph(baseline.value.data.draft));
const title = ref(baseline.value.data.workflow.title);
const studies = ref<StudyNode[]>(graph.value?.studies.map((node) => ({ ...node })) ?? []);
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
const nodeList = ref<HTMLOListElement>();
const errorSummary = ref<HTMLElement>();
const dragged = ref('');
const hovered = ref('');

function adopt(snapshot: ApiResponse<WorkflowDetail>) {
    baseline.value = snapshot;
    title.value = snapshot.data.workflow.title;
    studies.value = graph.value?.studies.map((node) => ({ ...node })) ?? [];
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

function focusNode(id: string, selector: string) {
    void nextTick(() =>
        nodeList.value?.querySelector<HTMLElement>(`[data-node-id="${id}"] ${selector}`)?.focus(),
    );
}

function add() {
    if (busy.value || studies.value.length >= maxStudies) return;
    const id = crypto.randomUUID();
    studies.value.push({ id, type: 'study', taskId: '' });
    announcement.value = `已添加研究 ${studies.value.length}`;
    focusNode(id, 'select');
}

function remove(index: number) {
    if (busy.value) return;
    studies.value.splice(index, 1);
    announcement.value = `已删除研究 ${index + 1}`;
    const next = studies.value[index] ?? studies.value.at(-1);
    if (next) focusNode(next.id, 'select');
    else void nextTick(() => document.getElementById('workflow-add-node')?.focus());
}

function move(from: number, to: number, keyboardDirection?: 'up' | 'down') {
    const node = studies.value[from];
    if (busy.value || !node || from === to || to < 0 || to >= studies.value.length) return;
    studies.value = studies.value.toSpliced(from, 1).toSpliced(to, 0, node);
    announcement.value = `研究 ${from + 1} 已移到第 ${to + 1} 个位置`;
    if (!keyboardDirection) return;
    const next = to === 0 ? 'down' : to === studies.value.length - 1 ? 'up' : keyboardDirection;
    focusNode(node.id, `[data-move="${next}"]`);
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

.workflow-node {
    padding: 0.75rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
    overflow-wrap: anywhere;
}

.grab-handle[draggable='true'] {
    cursor: grab;
}

.drop-target {
    outline: 2px solid currentColor;
    outline-offset: -2px;
}
</style>
