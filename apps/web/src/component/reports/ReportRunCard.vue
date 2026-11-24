<template>
    <section class="run-card layout-grid gap-3 rounded-3 bg-surface p-3" aria-label="本轮执行">
        <header class="flex flex-wrap items-center justify-between gap-2">
            <strong
                >{{ title }} · {{ run ? executionStates[run.status][0] : '正在读取执行' }}</strong
            >
            <router-link class="navigation-link" :to="`/runs/${targetId}`"
                >执行详情<app-icon name="chevron"
            /></router-link>
        </header>
        <p v-if="execution.query.isError.value" role="alert">
            执行暂时无法读取。<button type="button" @click="execution.query.refetch()">
                重新读取
            </button>
        </p>
        <template v-if="run">
            <ol v-if="active" class="run-stages" aria-label="执行阶段">
                <li
                    v-for="(label, index) in stages"
                    :key="label"
                    :aria-current="stage === index ? 'step' : undefined"
                    :class="{ reached: stage >= index }"
                >
                    {{ label }}
                </li>
            </ol>
            <p v-if="run.status === 'cancel_requested'" role="status">
                正在停止，等待后台结束当前工作。
            </p>
            <div v-else-if="run.status === 'failed'" class="layout-grid gap-1" role="status">
                <p>{{ executionFailure(run) }}</p>
                <button
                    v-if="report"
                    type="button"
                    class="original-artifact"
                    @click="emit('openOriginal')"
                >
                    打开原报告<app-icon name="chevron" />
                </button>
            </div>
            <p v-else-if="run.status === 'canceled'">执行已停止。</p>
            <p v-else-if="active && !execution.log.value.currentStep" class="text-muted">
                {{ executionStates[run.status][1] }}
            </p>
            <template v-if="completedReport">
                <p class="m-0 whitespace-pre-wrap">{{ completedReport.summary }}</p>
                <button
                    type="button"
                    class="completed-artifact"
                    :aria-label="`打开成果 · ${completedReport.title}`"
                    @click="emit('openArtifact', artifact!)"
                >
                    <app-icon name="report" /><span
                        ><strong>{{ completedReport.title }}</strong
                        ><small>{{
                            [origin, formatsText, reportDeliveryStatus(completedReport)]
                                .filter(Boolean)
                                .join(' · ')
                        }}</small></span
                    ><app-icon name="source" />
                </button>
                <button
                    v-if="operation !== 'merge'"
                    type="button"
                    @click="emit('merge', completedReport.id)"
                >
                    合并到原报告
                </button>
            </template>
            <p v-else-if="['succeeded', 'partial'].includes(run.status)" role="status">
                正在读取已生成的成果。<button
                    v-if="result.query.isError.value || execution.reports.isError.value"
                    type="button"
                    @click="readResult"
                >
                    重新读取成果
                </button>
            </p>
            <div class="flex flex-wrap gap-2">
                <action-button
                    v-if="['queued', 'running', 'recovering'].includes(run.status)"
                    :disabled="actions.locked.value"
                    :busy="actions.pending.value"
                    @click="actions.submit('cancel')"
                    >停止执行</action-button
                >
                <action-button
                    v-if="['failed', 'canceled'].includes(run.status)"
                    :disabled="actions.locked.value"
                    :busy="actions.pending.value"
                    @click="actions.submit('retry')"
                    >重新执行</action-button
                >
                <action-button
                    v-if="actions.phase.value === 'uncertain'"
                    :busy="actions.pending.value"
                    @click="actions.replay"
                    >使用同一命令确认</action-button
                >
            </div>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { outputFormatLabels, type ReportConversation, type Report, type Run } from '@scova/models';
import AppIcon from '@/component/common/AppIcon.vue';
import ActionButton from '@/component/common/ActionButton.vue';
import { useExecution, executionStates, executionFailure } from '@/composable/useExecution';
import { useRunActions } from '@/composable/useRunActions';
import { useReport } from '@/composable/useReport';
import { useActionNotification } from '@/composable/useActionNotification';
import { reportDeliveryStatus } from '@/utils/report/summary';
import { savedArtifactFormats } from '@/utils/report/artifacts';

type Artifact = NonNullable<ReportConversation['artifacts']>[number];
const props = defineProps<{
    runId: string;
    questionId: string;
    operation: 'research' | 'revise' | 'merge';
    round?: number;
    report?: Report;
    latestRunId?: string;
}>();
const emit = defineEmits<{
    openArtifact: [artifact: Artifact];
    openOriginal: [];
    artifact: [artifact: Artifact];
    activeChange: [active: boolean];
    protectedChange: [value: boolean];
    merge: [reportId: string];
}>();
const retryId = ref('');
const targetId = computed(() =>
    props.report ? retryId.value || props.latestRunId || props.runId : '',
);
const execution = useExecution(targetId);
const run = computed(() => {
    const value = execution.run.value,
        report = props.report;
    return value &&
        report &&
        value.taskId === report.taskId &&
        value.taskVersionId === report.taskVersionId &&
        value.mode === report.mode
        ? value
        : undefined;
});
const lastRun = shallowRef<Run>();
watch(
    run,
    (value) => {
        if (value) lastRun.value = value;
    },
    { immediate: true },
);
const actions = useRunActions(() => ({ taskId: lastRun.value?.taskId ?? '', run: lastRun.value }));
useActionNotification().watch(actions.message, () =>
    actions.phase.value === 'success' ? 'success' : 'warning',
);
watch(actions.result, (value) => {
    const previous = lastRun.value;
    if (
        value &&
        previous &&
        value.run.id !== targetId.value &&
        value.run.parentRunId === previous.id &&
        value.run.trigger === 'retry' &&
        value.run.taskId === previous.taskId &&
        value.run.taskVersionId === previous.taskVersionId &&
        value.run.mode === previous.mode &&
        Object.entries(previous.budget).every(
            ([key, budget]) => Reflect.get(value.run.budget, key) === budget,
        )
    )
        retryId.value = value.run.id;
});
const result = useReport(() => (run.value ? execution.reportId.value : undefined));
const completedReport = computed(() => {
    const value = result.report.value;
    return value &&
        value.runId === run.value?.id &&
        value.taskId === run.value.taskId &&
        value.taskVersionId === run.value.taskVersionId &&
        value.mode === run.value.mode &&
        value.conversation?.reportId === props.report?.id &&
        value.conversation?.questionId === props.questionId &&
        value.conversation?.operation === props.operation
        ? value
        : undefined;
});
const title = computed(() =>
    props.operation === 'merge'
        ? '合并报告'
        : props.operation === 'revise'
          ? '资料内改写'
          : '补充研究',
);
const formatsText = computed(() =>
    completedReport.value
        ? savedArtifactFormats(completedReport.value)
              .map((key) => outputFormatLabels[key])
              .join('、')
        : '',
);
const origin = computed(() => `${props.round ? `第 ${props.round} 轮` : '本轮'} · ${title.value}`);
const active = computed(
    () =>
        !!run.value &&
        ['queued', 'running', 'recovering', 'cancel_requested'].includes(run.value.status),
);
const stages = computed(() =>
    props.operation !== 'research'
        ? ['阅读整理', '撰写成果']
        : ['查找资料', '阅读整理', '撰写成果'],
);
const stage = computed(() => {
    const step = execution.log.value.currentStep;
    if (!step || run.value?.status === 'queued') return -1;
    const writing = ['synthesize', 'validate', 'ready_for_delivery'].includes(step);
    if (props.operation !== 'research') return writing ? 1 : 0;
    return writing ? 2 : ['read', 'verify', 'compare'].includes(step) ? 1 : 0;
});
const artifact = computed<Artifact | undefined>(() =>
    completedReport.value
        ? {
              reportId: completedReport.value.id,
              runId: completedReport.value.runId,
              questionId: props.questionId,
              operation: props.operation,
              title: completedReport.value.title,
              ...(props.round ? { round: props.round } : {}),
          }
        : undefined,
);
watch(
    artifact,
    (value) => {
        if (value) emit('artifact', value);
    },
    { immediate: true },
);
watch(active, (value) => emit('activeChange', value), { immediate: true });
watch(
    () => actions.pending.value || actions.phase.value === 'uncertain',
    (value) => emit('protectedChange', value),
    { immediate: true },
);
async function readResult() {
    await execution.reports.refetch();
    await result.query.refetch();
}
onUnmounted(() => {
    emit('activeChange', false);
    emit('protectedChange', false);
});
</script>

<style scoped>
.run-stages {
    @apply flex flex-wrap gap-2 list-none p-0 m-0 text-muted text-sm;
}
.run-stages li {
    @apply rounded-2 border-theme px-3 py-2;
}
.run-stages .reached {
    @apply text-primary [background:var(--scova-selected)];
}
.run-stages [aria-current='step'] {
    @apply font-semibold;
}
.completed-artifact {
    @apply font-inherit flex flex-wrap items-center gap-3 w-full min-w-0 min-h-11 border-0 rounded-3 [background:var(--scova-selected)] text-default text-start p-3 cursor-pointer keyboard-focus-wide;
}
.completed-artifact > span:first-of-type {
    @apply grid gap-1 flex-1 min-w-0;
}
.completed-artifact small {
    @apply text-muted;
}
p {
    @apply m-0;
}
.completed-artifact:hover {
    background: color-mix(in srgb, var(--scova-selected) 85%, var(--scova-text));
}
.completed-artifact .app-icon {
    transition: scale 140ms ease;
}
.completed-artifact:active .app-icon {
    scale: 0.9;
}
@media (prefers-reduced-motion: reduce) {
    .completed-artifact .app-icon {
        transition: none;
        scale: none;
    }
}
button.original-artifact {
    @apply inline-flex items-center gap-1 justify-self-start;
}
button:not(.completed-artifact) {
    @apply font-inherit text-primary bg-transparent border-theme rounded-2 min-h-11 px-3 cursor-pointer keyboard-focus-wide;
}
</style>
