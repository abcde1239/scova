<template>
    <ol class="layout-grid gap-2 m-0 p-0 list-none" aria-label="节点运行状态">
        <li
            v-for="node in run.nodes"
            :key="node.id"
            class="surface-card p-3 layout-grid gap-2 break-anywhere"
        >
            <span class="font-semibold"
                >{{ labels.get(node.id) ?? nodeTypes[node.type].name }} ·
                {{ statusLabels[node.status] }}</span
            >
            <span v-if="node.parallelGroup"
                >并行组 {{ parallelGroups.indexOf(node.parallelGroup) + 1 }}</span
            >
            <span v-if="node.attempt">执行尝试 {{ node.attempt }}</span>
            <span v-if="node.failureCode">{{ node.failureCode }}</span>
            <span v-if="node.startedAt && node.finishedAt"
                >耗时 {{ elapsed(node.startedAt, node.finishedAt) }}</span
            >
            <router-link
                v-if="node.childRunId"
                class="internal-link"
                :to="{ name: 'run-detail', params: { runId: node.childRunId } }"
                >查看研究执行</router-link
            >
            <router-link
                v-if="node.output?.reportId"
                class="internal-link"
                :to="{ name: 'report-detail', params: { reportId: node.output.reportId } }"
                >打开研究报告</router-link
            >
            <details v-if="node.output?.table" class="min-w-0">
                <summary>{{ node.output.table.rows.length }} 行 · 表格预览</summary>
                <div class="overflow-auto mt-2">
                    <table>
                        <caption class="sr-only">
                            前五行数据
                        </caption>
                        <thead>
                            <tr>
                                <th
                                    v-for="column in node.output.table.columns"
                                    :key="column"
                                    scope="col"
                                >
                                    {{ column }}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="(row, rowIndex) in node.output.table.rows.slice(0, 5)"
                                :key="rowIndex"
                            >
                                <td v-for="(cell, cellIndex) in row" :key="cellIndex">
                                    {{ cell }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </details>
            <details v-if="node.output?.text">
                <summary>文本输出</summary>
                <pre class="m-0 whitespace-pre-wrap">{{ node.output.text.slice(0, 4000) }}</pre>
            </details>
            <div
                v-if="node.output?.artifact"
                :id="`workflow-artifact-${node.id}`"
                class="flex flex-wrap items-center gap-2"
                :class="{ 'font-semibold': artifactId === node.id }"
            >
                <action-button @click="download(node.output.artifact)"
                    >下载 {{ node.output.artifact.filename }}</action-button
                >
            </div>
            <div v-if="node.output?.notification" class="layout-grid gap-1">
                <span class="font-semibold"
                    >{{ run.preview ? '站内通知预览' : '站内通知' }} ·
                    {{ node.output.notification.title }}</span
                >
                <span class="whitespace-pre-wrap">{{ node.output.notification.body }}</span>
            </div>
        </li>
    </ol>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { WorkflowCanvasOutput, WorkflowGraph, WorkflowRun } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import { nodeTypes } from '@/utils/workflow/canvas';
import { workflowStatusLabels as statusLabels } from '@/utils/workflow/serial';

const props = defineProps<{ run: WorkflowRun; graph?: WorkflowGraph; artifactId?: string }>();
const labels = computed(
    () =>
        new Map(
            props.graph?.nodes.map((node) => [node.id, 'label' in node ? node.label : undefined]),
        ),
);
const parallelGroups = computed(() => [
    ...new Set(props.run.nodes.flatMap((node) => (node.parallelGroup ? [node.parallelGroup] : []))),
]);
function elapsed(start: string, end: string) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function download(artifact: NonNullable<WorkflowCanvasOutput['artifact']>) {
    const mime =
        artifact.format === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8';
    const url = URL.createObjectURL(new Blob([artifact.content], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = artifact.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<style scoped>
th,
td {
    padding: 0.25rem 0.5rem;
    text-align: start;
    border-bottom: 1px solid var(--scova-border);
}
</style>
