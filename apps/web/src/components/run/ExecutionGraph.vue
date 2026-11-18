<template>
    <section class="execution-graph scova-surface" aria-label="研究运行图">
        <div class="action-row justify-between">
            <h2 class="text-[1.25rem] leading-[1.5] m-0">研究运行图</h2>
            <action-button quaternary :busy="refreshing" @click="$emit('refresh')"
                >刷新运行图</action-button
            >
        </div>
        <p v-if="stale" class="m-0 text-muted" role="status">
            运行图暂未更新，当前保留上次成功读取的状态。
        </p>
        <p
            v-if="!snapshot.historyComplete || snapshot.precision === 'legacy'"
            class="m-0 text-muted leading-[1.65]"
        >
            历史节点记录不完整，仅展示已保存的阶段汇总和可确认的执行实例。
        </p>
        <p v-if="snapshot.truncated" class="m-0 text-muted">
            仅展示最近保留的节点实例，完整过程请结合执行日志查看。
        </p>
        <template v-if="snapshot.graphVersion === 1">
            <p class="m-0 text-muted leading-[1.65]">
                连线表示允许的流程路径，节点可重复执行。选择节点查看每次执行与恢复记录。
            </p>
            <p class="m-0 leading-[1.65]" role="status">{{ currentLabel }}</p>
            <div
                class="graph-scroll"
                role="region"
                aria-label="研究节点与流程连线，可横向滚动"
                tabindex="0"
            >
                <div class="graph-board">
                    <svg
                        class="graph-edges"
                        viewBox="0 0 1000 800"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                        focusable="false"
                    >
                        <defs>
                            <marker
                                :id="arrowId"
                                viewBox="0 0 10 10"
                                refX="8"
                                refY="5"
                                markerWidth="5"
                                markerHeight="5"
                                orient="auto-start-reverse"
                            >
                                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                            </marker>
                        </defs>
                        <path
                            v-for="(edge, index) in edges"
                            :key="index"
                            :d="edge.path"
                            :marker-end="`url(#${arrowId})`"
                        />
                    </svg>
                    <button
                        v-for="node in nodes"
                        :key="node.id"
                        type="button"
                        class="graph-node"
                        :class="`graph-node--${node.state.status}`"
                        :style="{
                            left: `${node.position[0]}%`,
                            top: `${node.position[1] * 1.25}%`,
                        }"
                        :aria-pressed="selected === node.id"
                        :aria-controls="detailId"
                        @click="selectedStep = node.id"
                    >
                        <span class="font-medium">{{ node.label }}</span>
                        <span>{{ graphStatusLabels[node.state.status] }}</span>
                        <span class="text-[0.8125rem]">{{
                            node.state.instances.length
                                ? `${node.state.instances.length} 次执行 · 完成 ${node.state.completed} 次`
                                : node.state.legacy
                                  ? `历史开始 ${node.state.legacy.started} 次`
                                  : '未记录执行实例'
                        }}</span>
                    </button>
                </div>
            </div>
        </template>
        <p v-else class="m-0 text-muted">此执行未保存可匹配的研究图版本，以下保留阶段汇总。</p>
        <details v-if="snapshot.legacySteps.length" class="graph-legacy">
            <summary>历史阶段汇总</summary>
            <ul class="m-0 pl-5 layout-grid gap-2">
                <li v-for="step in snapshot.legacySteps" :key="step.step">
                    {{ label(step.step) }}：开始 {{ step.started }} 次，节点结束
                    {{ step.completed }} 次
                </li>
            </ul>
        </details>
        <section :id="detailId" class="graph-detail" :aria-label="`${label(selected)}执行记录`">
            <h3 class="m-0 text-[1rem]">{{ label(selected) }} · 执行记录</h3>
            <p v-if="!selectedInstances.length" class="m-0 text-muted">
                {{
                    snapshot.precision === 'legacy'
                        ? '历史记录不足以还原此节点的执行实例。'
                        : '此节点尚未执行，后续是否进入由研究流程决定。'
                }}
            </p>
            <ol v-else class="graph-history">
                <li
                    v-for="instance in selectedInstances"
                    :key="instance.instanceId"
                    class="layout-grid gap-2"
                >
                    <p class="m-0 font-medium">
                        节点实例 #{{ instance.ordinal }} · {{ instance.attempts.length }} 次尝试
                    </p>
                    <ol class="m-0 pl-5 layout-grid gap-2">
                        <li
                            v-for="attempt in instance.attempts"
                            :key="attempt.attemptId"
                            class="break-anywhere leading-[1.65]"
                        >
                            尝试 {{ attempt.number }} · {{ graphStatusLabels[attempt.status] }} ·
                            {{ graphDuration(attempt.durationMs) }}
                            <span class="block text-muted text-[0.875rem]"
                                ><time :datetime="attempt.startedAt">{{
                                    time(attempt.startedAt)
                                }}</time
                                ><template v-if="attempt.finishedAt">
                                    →
                                    <time :datetime="attempt.finishedAt">{{
                                        time(attempt.finishedAt)
                                    }}</time></template
                                ></span
                            >
                        </li>
                    </ol>
                </li>
            </ol>
        </section>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import type { RunGraphSnapshot } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import {
    graphNodeState,
    graphStatusLabels,
    graphDuration,
    graphPosition,
    graphEdgePath,
    type GraphStep,
} from '@/models/run-graph';
import { stepLabels } from '@/utils/execution-log';

const props = defineProps<{ snapshot: RunGraphSnapshot; refreshing?: boolean; stale?: boolean }>();
defineEmits<{ refresh: [] }>();
const arrowId = `${useId()}-graph-arrow`;
const detailId = `${useId()}-graph-detail`;
const selectedStep = ref<GraphStep>();
const nodes = computed(() =>
    props.snapshot.nodes.map((node, index) => ({
        ...node,
        position: graphPosition(node.id, index),
        state: graphNodeState(props.snapshot, node.id),
    })),
);
const selected = computed(
    () =>
        nodes.value.find((node) => node.id === selectedStep.value)?.id ??
        nodes.value.find((node) => node.state.status === 'running')?.id ??
        props.snapshot.instances.at(-1)?.step ??
        props.snapshot.nodes[0]?.id ??
        'load_context',
);
const selectedInstances = computed(() =>
    props.snapshot.instances
        .filter((entry) => entry.step === selected.value)
        .slice(-30)
        .reverse(),
);
const label = (step: GraphStep) =>
    props.snapshot.nodes.find((node) => node.id === step)?.label ?? stepLabels[step];
const edges = computed(() =>
    props.snapshot.edges.flatMap((edge) => {
        const from = nodes.value.find((node) => node.id === edge.from);
        const to = nodes.value.find((node) => node.id === edge.to);
        return from && to ? [{ path: graphEdgePath(from.position, to.position) }] : [];
    }),
);
const currentLabel = computed(() => {
    const active = nodes.value.filter((node) => node.state.status === 'running');
    return active.length
        ? `当前：${active.map((node) => node.label).join('、')}`
        : ['succeeded', 'partial', 'failed', 'canceled'].includes(props.snapshot.runStatus)
          ? '本次执行已结束，各节点状态以保存记录为准。'
          : props.snapshot.runStatus === 'recovering'
            ? '执行恢复中，等待后台确认节点状态。'
            : '等待下一个节点状态更新。';
});
const time = (instant: string) => new Date(instant).toLocaleString('zh-CN', { hour12: false });
</script>

<style scoped>
.execution-graph {
    @apply min-w-0 max-w-full layout-grid gap-4 rounded-3 p-[clamp(1rem,_3%,_2rem)];
}
.graph-scroll {
    @apply overflow-x-auto max-w-full rounded-2 [border:0.0625rem_solid_var(--scova-border)];
}
.graph-board {
    @apply relative min-w-[54rem] h-[42rem];
}
.graph-edges {
    @apply absolute inset-0 w-full h-full text-muted opacity-35 overflow-visible;
}
.graph-edges > path {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
}
.graph-node {
    @apply absolute [-webkit-appearance:none] [appearance:none] [-translate-x:50%] [-translate-y:50%] w-[21%] min-h-[5.5rem] p-3 rounded-2 text-[0.875rem] leading-[1.5] [font:inherit] [color:var(--scova-text)] bg-surface [border:0.0625rem_solid_var(--scova-border)] grid gap-1 text-left break-anywhere cursor-pointer;
    transform: translate(-50%, -50%);
}
.graph-node[aria-pressed='true'] {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem];
}
.graph-node:focus-visible,
.graph-scroll:focus-visible {
    @apply [outline:0.1875rem_solid_var(--scova-primary)] [outline-offset:0.1875rem];
}
.graph-node--running {
    @apply [border-color:var(--scova-primary)] [background:var(--scova-selected)];
}
.graph-node--succeeded {
    @apply [border-color:var(--scova-primary)];
}
.graph-detail {
    @apply layout-grid gap-3 pt-4 [border-top:0.0625rem_solid_var(--scova-border)];
}
.graph-history {
    @apply m-0 pl-5 layout-grid gap-5;
}
.graph-legacy summary {
    @apply cursor-pointer min-h-11 [align-content:center];
}
</style>
