<template>
    <section
        v-if="opened || runCards.length"
        ref="root"
        class="merge-action layout-grid gap-3 min-w-0"
        aria-label="合并报告"
    >
        <section v-if="opened" class="layout-grid gap-3 border-theme rounded-3 p-4">
            <h3 tabindex="-1" class="m-0 text-base">合并到原报告</h3>
            <p class="m-0 text-muted text-sm">
                原报告自动包含。选择续作，使用保存证据生成新的合并报告，原成果均保留。
            </p>
            <fieldset :disabled="locked" class="grid gap-2 min-w-0 border-0 p-0 m-0">
                <legend class="sr-only">选择续作</legend>
                <label
                    v-for="artifact in artifacts"
                    :key="artifact.reportId"
                    class="flex items-start gap-2 min-h-11 break-anywhere"
                    ><input v-model="selected" type="checkbox" :value="artifact.reportId" /><span
                        >{{ artifact.round ? `第 ${artifact.round} 轮 · ` : ''
                        }}{{ artifact.title }}</span
                    ></label
                >
            </fieldset>
            <p v-if="selected.length > 8" role="alert">一次最多选择 8 份续作。</p>
            <output-format-select
                compact
                v-model="formats"
                label="合并成果形式"
                :allow-empty="true"
                :disabled="locked"
            />
            <p v-if="!formats.length" class="text-muted text-sm m-0">成果形式沿用原报告配置</p>
            <p v-if="parentQuery.isFetching.value" role="status">正在读取执行预算</p>
            <div v-else-if="!parent" role="alert">
                原执行暂不可读取。<button type="button" @click="parentQuery.refetch()">
                    重新读取预算
                </button>
            </div>
            <details v-if="parent">
                <summary>预算详情</summary>
                <p>
                    最多读取 {{ parent.budget.maxPages }} 份保存资料 ·
                    {{ parent.budget.maxDurationSeconds }} 秒 · 输入
                    {{ parent.budget.maxInputTokens }} / 输出
                    {{ parent.budget.maxOutputTokens }} token
                </p>
            </details>
            <p v-if="phase === 'uncertain' || phase === 'blocked'" role="status">
                合并结果尚未确认，已保留原请求。{{
                    phase === 'blocked'
                        ? '请求与保存记录不一致，请返回任务摘要查看。'
                        : '使用同一请求确认不会重复建立执行。'
                }}
            </p>
            <router-link
                v-if="report && ['rejected', 'blocked'].includes(phase)"
                class="navigation-link"
                :to="`/tasks/${report.taskId}`"
                >返回任务摘要<app-icon name="chevron"
            /></router-link>
            <footer
                class="flex flex-wrap justify-between items-center gap-2 [border-top:0.0625rem_solid_var(--scova-border)] pt-3"
            >
                <span class="text-sm text-muted">不联网 · 计入模型额度</span>
                <div class="flex flex-wrap gap-2">
                    <button type="button" :disabled="locked" @click="opened = false">取消</button
                    ><action-button
                        v-if="phase === 'uncertain'"
                        :disabled="pending || !report"
                        :busy="pending"
                        @click="send"
                        >使用同一请求确认</action-button
                    ><action-button
                        v-else
                        :disabled="
                            locked || !parent || !report || !selected.length || selected.length > 8
                        "
                        :busy="pending"
                        @click="start"
                        >开始合并</action-button
                    >
                </div>
            </footer>
        </section>
        <report-run-card
            :report="report"
            v-show="!!report"
            v-for="run in runCards"
            :key="run.rootRunId ?? run.runId"
            :run-id="run.rootRunId ?? run.runId"
            :latest-run-id="run.runId"
            :question-id="run.questionId"
            operation="merge"
            :round="run.round"
            @artifact="emit('artifact', $event)"
            @open-artifact="emit('openArtifact', $event)"
            @protected-change="setProtected(run.runId, $event)"
            @active-change="setActive(run.runId, $event)"
        />
    </section>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue';
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { Report, ReportConversation, OutputFormat, Run } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import OutputFormatSelect from '@/components/tasks/OutputFormatSelect.vue';
import ReportRunCard from '@/components/reports/ReportRunCard.vue';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { useActionNotification } from '@/composables/useActionNotification';
import { runQueryOptions } from '@/api/runs';
import { mergeReportEndpoint } from '@/api/report-questions';
import { followupParent, followupRun } from '@/api/followup';
import { toApiError } from '@/api/errors';
type Artifact = NonNullable<ReportConversation['artifacts']>[number];
type MergeRun = NonNullable<ReportConversation['mergeRuns']>[number];
const props = defineProps<{
    reportId: string;
    report?: Report;
    artifacts: Artifact[];
    runs: MergeRun[];
}>();
const emit = defineEmits<{
    artifact: [artifact: Artifact];
    openArtifact: [artifact: Artifact];
    protectedChange: [value: boolean];
    activeChange: [value: boolean];
}>();
const lifecycle = useSessionLifecycle();
const opened = ref(false),
    pending = ref(false);
const selected = ref<string[]>([]),
    formats = ref<OutputFormat[]>([]);
const phase = ref<'idle' | 'sending' | 'uncertain' | 'blocked' | 'rejected' | 'success'>('idle');
const notice = ref('');
const root = ref<HTMLElement>();
const frozen = shallowRef<{
    reportId: string;
    key: string;
    body: { confirm: true; reportIds: string[]; outputFormats?: OutputFormat[] };
    parent: Run;
    questionId: string;
    round?: number;
}>();
const confirmed = ref<MergeRun[]>([]);
const protectedRuns = ref<Record<string, boolean>>({});
const activeRuns = ref<Record<string, boolean>>({});
const runCards = computed(() => [
    ...new Map(
        [...confirmed.value, ...props.runs].map((run) => [run.rootRunId ?? run.runId, run]),
    ).values(),
]);
const locked = computed(
    () => pending.value || ['uncertain', 'blocked', 'sending'].includes(phase.value),
);
const parentQuery = useQuery(
    computed(() => ({
        ...runQueryOptions(
            lifecycle,
            props.report?.runId ?? '00000000-0000-4000-8000-000000000000',
        ),
        enabled: !!props.report && opened.value,
    })),
    lifecycle.queryClient,
);
const parent = computed(() => {
    if (!props.report || !parentQuery.isSuccess.value || parentQuery.isFetching.value)
        return undefined;
    try {
        return followupParent(parentQuery.data.value!.data, props.report);
    } catch {
        return undefined;
    }
});
useActionNotification().watch(notice, () =>
    phase.value === 'success' ? 'success' : phase.value === 'rejected' ? 'error' : 'warning',
);
let controller = new AbortController();
watch(
    () => `${lifecycle.session.epoch}:${props.reportId}`,
    () => {
        controller.abort();
        controller = new AbortController();
        frozen.value = undefined;
        confirmed.value = [];
        opened.value = false;
        pending.value = false;
        phase.value = 'idle';
        selected.value = [];
        formats.value = [];
        protectedRuns.value = {};
        activeRuns.value = {};
    },
    { flush: 'sync' },
);
async function open(reportId?: string) {
    if (locked.value || props.report?.mode !== 'live') return;
    selected.value =
        reportId && props.artifacts.some((item) => item.reportId === reportId)
            ? [reportId]
            : props.artifacts
                  .filter((item) => item.operation !== 'merge')
                  .slice(-8)
                  .map((item) => item.reportId);
    opened.value = true;
    phase.value = 'idle';
    await nextTick();
    root.value?.querySelector<HTMLElement>('h3')?.focus();
}
async function start() {
    if (!parent.value || locked.value || !selected.value.length || selected.value.length > 8)
        return;
    const anchor = props.artifacts
        .filter((item) => selected.value.includes(item.reportId))
        .sort((a, b) => a.reportId.localeCompare(b.reportId))
        .at(-1);
    if (!anchor || !props.report) return;
    frozen.value = {
        reportId: props.reportId,
        key: crypto.randomUUID(),
        body: {
            confirm: true,
            reportIds: [...selected.value].sort(),
            ...(formats.value.length ? { outputFormats: [...formats.value] } : {}),
        },
        parent: parent.value,
        questionId: anchor.questionId,
        round: anchor.round,
    };
    await send();
}
async function send() {
    const attempt = frozen.value;
    if (!attempt || pending.value || !props.report || phase.value === 'blocked') return;
    const scope = lifecycle.capture();
    const current = () =>
        scope.isCurrent() && frozen.value === attempt && props.reportId === attempt.reportId;
    pending.value = true;
    phase.value = 'sending';
    notice.value = '';
    try {
        const result = await scope.request(
            mergeReportEndpoint,
            { params: { reportId: attempt.reportId }, body: attempt.body },
            { idempotencyKey: attempt.key, signal: controller.signal },
        );
        if (!current()) return;
        if (result.status !== 202 || (!result.data.reused && result.data.run.status !== 'queued'))
            throw new Error('合并执行响应不完整');
        followupRun(result.data.run, {
            parentRunId: attempt.parent.id,
            taskId: attempt.parent.taskId,
            taskVersionId: attempt.parent.taskVersionId,
            mode: attempt.parent.mode,
            budget: attempt.parent.budget,
        });
        confirmed.value = [
            ...confirmed.value.filter((item) => item.runId !== result.data.run.id),
            {
                runId: result.data.run.id,
                rootRunId: result.data.run.id,
                questionId: attempt.questionId,
                ...(attempt.round ? { round: attempt.round } : {}),
            },
        ];
        phase.value = 'success';
        opened.value = false;
        notice.value = '合并执行已保存，原报告与续作均保留。';
        for (const key of [['report-conversation', attempt.reportId], ['runs'], ['tasks']])
            void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(key) });
    } catch (cause) {
        if (!current()) return;
        const error = toApiError(cause);
        phase.value =
            error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH'
                ? 'blocked'
                : !error.status ||
                    error.status === 408 ||
                    error.status >= 500 ||
                    ['validation', 'protocol'].includes(error.kind) ||
                    error.code === 'IDEMPOTENCY_PENDING'
                  ? 'uncertain'
                  : 'rejected';
        notice.value =
            phase.value === 'uncertain'
                ? '合并结果尚未确认，原请求已保留。'
                : error.code === 'RUN_ALREADY_ACTIVE'
                  ? '任务已有活动执行，请完成后再合并。'
                  : '合并未完成，请核对成果权限与执行状态。';
    } finally {
        if (current()) pending.value = false;
    }
}
function setProtected(id: string, value: boolean) {
    protectedRuns.value = { ...protectedRuns.value, [id]: value };
}
function setActive(id: string, value: boolean) {
    activeRuns.value = { ...activeRuns.value, [id]: value };
}
async function showRuns() {
    await nextTick();
    const card = root.value?.querySelector<HTMLElement>('.run-card');
    if (card) {
        card.tabIndex = -1;
        card.focus({ preventScroll: true });
        card.scrollIntoView({ block: 'nearest' });
    }
}
const protectedState = computed(
    () => locked.value || Object.values(protectedRuns.value).some(Boolean),
);
// ReportQuestions owns the shared route and unload guards.
watch(protectedState, (value) => emit('protectedChange', value), { immediate: true });
onScopeDispose(() => {
    controller.abort();
});
watch(
    () => Object.values(activeRuns.value).some(Boolean),
    (value) => emit('activeChange', value),
    { immediate: true },
);
defineExpose({ open, showRuns });
</script>

<style scoped>
.merge-action button {
    @apply font-inherit min-h-11 border-theme rounded-2 bg-transparent text-primary px-3 py-2 cursor-pointer keyboard-focus-wide;
}
.merge-action summary {
    @apply min-h-11 cursor-pointer keyboard-focus-wide;
}
.merge-action input {
    @apply mt-1.5 min-w-4 min-h-4 flex-none;
}
</style>
