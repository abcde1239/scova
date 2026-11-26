<template>
    <article
        v-if="item.kind === 'message'"
        class="thread-message"
        :class="{ 'thread-message--user': isUser }"
    >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span class="font-semibold">{{ isUser ? '你' : 'Scova' }}</span>
            <time :datetime="item.createdAt">{{ localTaskTime(item.createdAt) }}</time>
        </div>
        <p class="m-0 whitespace-pre-wrap leading-relaxed">{{ text ?? '消息内容不可用' }}</p>
        <ul v-if="reportRefs.length" class="grid gap-2 m-0 p-0 list-none" aria-label="引用报告">
            <li
                v-for="reportId in reportRefs"
                :key="reportId"
                class="flex flex-wrap items-center gap-2"
            >
                <router-link
                    class="internal-link"
                    :to="{ name: 'report-detail', params: { reportId } }"
                    >{{ reportTitle(reportId) }}</router-link
                >
                <action-button v-if="canReadInPane" text @click="$emit('read-report', reportId)"
                    >侧栏阅读</action-button
                >
            </li>
        </ul>
        <ul v-if="attachmentIds.length" class="grid gap-2 m-0 p-0 list-none" aria-label="会话附件">
            <li v-for="attachmentId in attachmentIds" :key="attachmentId">
                <project-thread-attachment-download
                    :thread-id="item.threadId"
                    :attachment-id="attachmentId"
                />
            </li>
        </ul>
        <action-button v-if="retryText" text :disabled="!canRetry" @click="$emit('retry-turn')"
            >编辑并重试</action-button
        >
    </article>
    <article v-else-if="item.kind === 'plan' && !decisionItem" class="thread-card">
        <div class="flex flex-wrap items-center gap-2">
            <app-icon name="tasks" />
            <h3 class="m-0 text-base">研究提案</h3>
            <span class="text-sm text-muted">{{ planStatus }}</span>
        </div>
        <p v-if="planTitle" class="m-0 font-medium">{{ planTitle }}</p>
        <p v-if="planObjective" class="m-0 whitespace-pre-wrap">{{ planObjective }}</p>
        <div v-if="pendingPlan && writable" class="flex flex-wrap items-center gap-2">
            <action-button
                type="primary"
                :busy="busyDecision === 'approve'"
                :disabled="busyDecision === 'reject'"
                @click="$emit('decide', 'approve')"
                >批准并开始研究</action-button
            >
            <action-button
                :busy="busyDecision === 'reject'"
                :disabled="busyDecision === 'approve'"
                @click="$emit('decide', 'reject')"
                >拒绝</action-button
            >
        </div>
        <router-link
            v-if="approvedRun"
            class="internal-link"
            :to="{ name: 'run-detail', params: { runId: approvedRun } }"
            >查看运行</router-link
        >
        <p v-if="decisionError" role="alert" class="m-0 text-sm text-danger">{{ decisionError }}</p>
        <router-link
            v-if="legacyPlan"
            class="internal-link"
            :to="{ name: 'project-legacy', params: { projectId } }"
            >在原项目页查看草案</router-link
        >
    </article>
    <article v-else-if="scheduleProposal" class="thread-card">
        <div class="flex flex-wrap items-center gap-2">
            <app-icon name="tasks" />
            <h3 class="m-0 text-base">{{ scheduleTitle }}</h3>
            <span class="text-sm text-muted">{{ scheduleStatus }}</span>
        </div>
        <p v-if="scheduleTaskTitle" class="m-0 font-medium">{{ scheduleTaskTitle }}</p>
        <p v-if="scheduleDescription" class="m-0 text-sm">{{ scheduleDescription }}</p>
        <router-link
            v-if="scheduleTaskId"
            class="internal-link"
            :to="{ name: 'task-summary', params: { taskId: scheduleTaskId } }"
            >查看任务</router-link
        >
        <div v-if="writable && status === 'pending'" class="flex flex-wrap gap-2">
            <action-button
                type="primary"
                :busy="busyDecision === 'approve'"
                :disabled="busyDecision === 'reject'"
                @click="$emit('decide', 'approve')"
                >批准计划</action-button
            >
            <action-button
                :busy="busyDecision === 'reject'"
                :disabled="busyDecision === 'approve'"
                @click="$emit('decide', 'reject')"
                >拒绝</action-button
            >
        </div>
        <action-button
            v-if="
                writable &&
                status === 'applied' &&
                (decision?.undoable ?? item.payload.undoable) === true
            "
            :busy="busyDecision === 'undo'"
            @click="$emit('decide', 'undo')"
            >撤销</action-button
        >
        <p v-if="decisionError" role="alert" class="m-0 text-sm text-danger">{{ decisionError }}</p>
    </article>
    <article v-else-if="item.kind === 'run' || item.kind === 'report'" class="thread-card">
        <div class="flex flex-wrap items-center gap-2">
            <app-icon :name="item.kind === 'report' ? 'report' : 'run'" />
            <h3 class="m-0 text-base">{{ outcomeTitle }}</h3>
            <span :role="item.kind === 'run' ? 'status' : undefined" class="text-sm text-muted">{{
                outcomeStatus
            }}</span>
        </div>
        <p v-if="reportUnavailable" class="m-0 text-muted">原报告已移出项目。</p>
        <div v-else ref="runLinks" class="flex flex-wrap items-center gap-3">
            <router-link
                v-if="runId"
                class="internal-link"
                :to="{ name: 'run-detail', params: { runId } }"
                >查看运行</router-link
            >
            <action-button
                v-if="runId && canCancelRun"
                :busy="activeRunCommand?.busy"
                @click="$emit('cancel-run', runId)"
                >取消运行</action-button
            >
            <router-link
                v-if="reportId"
                class="internal-link"
                :to="{ name: 'report-detail', params: { reportId } }"
                >打开报告</router-link
            >
            <action-button
                v-if="reportId && canReadInPane"
                text
                @click="$emit('read-report', reportId)"
                >侧栏阅读</action-button
            >
        </div>
        <p v-if="activeRunCommand?.error" role="alert" class="m-0 text-sm text-danger">
            {{ activeRunCommand.error }}
        </p>
        <p v-if="text && !reportUnavailable" class="m-0 whitespace-pre-wrap">{{ text }}</p>
    </article>
    <article v-else-if="!decisionItem" class="thread-card">
        <h3 class="m-0 text-base">{{ labels[item.kind] ?? '会话记录' }}</h3>
        <p v-if="text && Object.hasOwn(labels, item.kind)" class="m-0 whitespace-pre-wrap">
            {{ text }}
        </p>
        <div v-if="choices.length && writable" class="flex flex-wrap gap-2">
            <action-button
                v-for="choice in choices"
                :key="choice.label"
                :disabled="!canRetry"
                @click="$emit('choose', choice.message)"
                >{{ choice.label }}</action-button
            >
        </div>
    </article>
</template>

<script setup lang="ts">
import { computed, useTemplateRef, watch } from 'vue';
import { ProjectScheduleProposalSchema, parseContract, UuidSchema } from '@scova/models';
import type { ThreadDecision, ThreadItem } from '@/api/project-threads';
import { scheduleDescription as describeSchedule } from '@/utils/schedule';
import { localTaskTime } from '@/composable/useTasks';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import ProjectThreadAttachmentDownload from '@/component/projects/ProjectThreadAttachmentDownload.vue';

const props = defineProps<{
    item: ThreadItem;
    projectId: string;
    reportTitle: (id: string) => string;
    canReadInPane?: boolean;
    writable: boolean;
    canRetry: boolean;
    retryText?: string;
    decision?: {
        status: string;
        runId?: string | null;
        taskId?: string | null;
        undoable?: boolean;
    };
    runCommandState?: { busy?: boolean; status?: string; error?: string };
    taskTitle: (id: string) => string | undefined;
    busyDecision?: ThreadDecision;
    decisionError?: string;
}>();
defineEmits<{
    decide: [decision: ThreadDecision];
    'cancel-run': [runId: string];
    'read-report': [id: string];
    'retry-turn': [];
    choose: [message: string];
}>();
const uuid = new RegExp(UuidSchema.pattern!);
const id = (value: unknown) => (typeof value === 'string' && uuid.test(value) ? value : undefined);
const valueText = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value : undefined;
const labels: Record<string, string> = {
    tool_step: '工具步骤',
    schedule: '计划',
    disambiguation: '需要补充信息',
    notice: '会话通知',
};
const text = computed(() => valueText(props.item.payload.text));
// Clarifications may offer follow-up messages, such as drafting research on the same topic.
const choices = computed(() => {
    const raw = props.item.kind === 'disambiguation' ? props.item.payload.choices : undefined;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((choice: unknown) => {
        const { label, message } = (choice ?? {}) as Record<string, unknown>;
        return valueText(label) && valueText(message)
            ? [{ label: label as string, message: message as string }]
            : [];
    });
});
const isUser = computed(() => props.item.payload.role === 'user');
const decisionItem = computed(
    () => ['plan', 'schedule'].includes(props.item.kind) && !!id(props.item.payload.actionId),
);
const status = computed(() => props.decision?.status ?? props.item.status);
const pendingPlan = computed(
    () =>
        status.value === 'pending' &&
        props.item.payload.command === 'start_run' &&
        !!id(props.item.payload.draftId) &&
        typeof props.item.payload.revision === 'number',
);
const legacyPlan = computed(() => status.value === null && !!id(props.item.payload.draftId));
const planStatus = computed(
    () => ({ pending: '待确认', applied: '已批准', rejected: '已拒绝' })[status.value ?? ''] ?? '',
);
const scheduleProposal = computed(() => {
    if (props.item.kind !== 'schedule' || decisionItem.value) return;
    try {
        return parseContract(ProjectScheduleProposalSchema, props.item.payload);
    } catch {
        return;
    }
});
const scheduleTitle = computed(
    () =>
        ({
            create_schedule: '新建周期计划',
            update_schedule: '调整周期计划',
            pause_task: '暂停周期任务',
        })[scheduleProposal.value?.command ?? 'create_schedule'],
);
const scheduleTaskId = computed(() => id(props.decision?.taskId) ?? id(props.item.payload.taskId));
const scheduleTaskTitle = computed(() => {
    const proposal = scheduleProposal.value;
    if (proposal?.command === 'create_schedule') return proposal.task.config.title;
    if (scheduleTaskId.value) return props.taskTitle(scheduleTaskId.value);
});
const scheduleDescription = computed(() => {
    const proposal = scheduleProposal.value;
    if (!proposal || proposal.command === 'pause_task') return;
    const { schedule, timezone } =
        proposal.command === 'create_schedule' ? proposal.task.config : proposal;
    return describeSchedule(schedule, timezone);
});
const scheduleStatus = computed(
    () =>
        ({ pending: '待确认', applied: '已应用', rejected: '已拒绝', undone: '已撤销' })[
            status.value ?? ''
        ] ?? '',
);
const config = computed(() => {
    const value = props.item.payload.config;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
});
const planTitle = computed(() => valueText(config.value.title));
const planObjective = computed(
    () => valueText(config.value.objective) ?? valueText(config.value.description),
);
const attachmentIds = computed(() => [
    ...new Set(
        props.item.refs.flatMap((reference) => {
            if (
                !reference ||
                typeof reference !== 'object' ||
                !('kind' in reference) ||
                reference.kind !== 'attachment' ||
                !('id' in reference)
            )
                return [];
            const attachmentId = id(reference.id);
            return attachmentId ? [attachmentId] : [];
        }),
    ),
]);
const reportRefs = computed(() => [
    ...new Set(
        props.item.refs.flatMap((ref) => {
            if (
                !ref ||
                typeof ref !== 'object' ||
                !('kind' in ref) ||
                ref.kind !== 'report' ||
                !('id' in ref)
            )
                return [];
            const report = id(ref.id);
            return report ? [report] : [];
        }),
    ),
]);
const approvedRun = computed(() => id(props.decision?.runId ?? props.item.payload.runId));
const runId = computed(() => id(props.item.payload.runId));
const reportId = computed(
    () =>
        id(props.item.payload.reportId) ??
        (props.item.kind === 'report' ? reportRefs.value[0] : undefined),
);
const reportUnavailable = computed(
    () => props.item.kind === 'report' && props.item.payload.unavailable === true,
);
const outcomeTitle = computed(
    () =>
        (reportUnavailable.value ? undefined : valueText(props.item.payload.title)) ??
        (props.item.kind === 'report' ? '研究成果' : '研究运行'),
);
const activeRunStates = new Set(['queued', 'running', 'recovering']);
const storedRunStatus = computed(() => String(props.item.payload.status ?? status.value ?? ''));
const activeRunCommand = computed(() =>
    activeRunStates.has(storedRunStatus.value) ? props.runCommandState : undefined,
);
const runStatus = computed(() => activeRunCommand.value?.status ?? storedRunStatus.value);
const canCancelRun = computed(
    () => props.item.kind === 'run' && activeRunStates.has(runStatus.value),
);
const runLinks = useTemplateRef<HTMLDivElement>('runLinks');
watch(canCancelRun, (canCancel) => {
    if (!canCancel && runLinks.value?.querySelector('button:focus'))
        runLinks.value.querySelector('a')?.focus({ preventScroll: true });
});
const outcomeStatus = computed(
    () =>
        ({
            succeeded: '已完成',
            partial: '部分完成',
            failed: '失败',
            canceled: '已取消',
            queued: '排队中',
            running: '运行中',
            recovering: '恢复中',
            cancel_requested: '正在取消',
        })[runStatus.value] ?? '',
);
</script>

<style scoped>
.thread-message,
.thread-card {
    @apply grid min-w-0 max-w-full gap-2 break-anywhere;
}
.thread-message--user {
    @apply ml-auto w-fit max-w-[92%] rounded-3 px-4 py-3 [background:var(--scova-selected)];
}
.thread-card {
    @apply border-theme rounded-3 p-4 bg-surface;
}
</style>
