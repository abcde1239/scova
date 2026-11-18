<template>
    <form
        ref="form"
        class="task-config-form w-[min(100%,_44rem)] layout-grid gap-10 cursor-default"
        novalidate
        :aria-busy="task.pending.value"
        @submit.prevent="save"
    >
        <natural-language-draft
            v-if="creator"
            :task="creator"
            @applied="focusConfiguration"
            @manual="enterManualConfiguration"
        />
        <fieldset class="layout-grid gap-6 [border:0] m-0 p-0" :disabled="locked">
            <legend class="text-[1.25rem] font-semibold mb-6 p-0">查阅任务</legend>
            <task-config-field
                v-for="field in mainFields"
                :key="field.key"
                v-model="task.draft[field.key]"
                :label="field.label"
                :kind="field.kind"
                :error="task.fields.value[field.key]"
                :disabled="locked"
            />
        </fieldset>
        <fieldset class="layout-grid gap-6 [border:0] m-0 p-0" :disabled="locked">
            <legend class="text-[1.25rem] font-semibold mb-6 p-0">时间与输出</legend>
            <task-execution-settings
                v-model:agent="task.draft.agentProviderId"
                v-model:search="task.draft.searchMode"
                :disabled="locked"
            />
            <fieldset class="layout-grid gap-3 border-0 p-0 m-0">
                <legend class="font-semibold mb-2">任务类型</legend>
                <label
                    v-for="mode in researchModes"
                    :key="mode.value"
                    class="flex items-start gap-3 min-h-11 cursor-pointer"
                >
                    <input
                        v-model="task.draft.researchMode"
                        type="radio"
                        name="research-mode"
                        :value="mode.value"
                        class="mt-1.5"
                        @change="selectResearchMode(mode.value)"
                    />
                    <span
                        ><strong>{{ mode.label }}</strong
                        ><span class="block text-muted">{{ mode.description }}</span></span
                    >
                </label>
            </fieldset>
            <task-config-field
                v-if="task.draft.researchMode === 'collection'"
                v-model="task.draft.collectionDateUnknown"
                label="日期未确认的条目"
                kind="select"
                :options="unknownDateOptions"
                :error="task.fields.value.collectionDateUnknown"
                :disabled="locked"
            />
            <task-config-field
                v-model="task.draft.rangeKind"
                label="查阅时间范围"
                kind="select"
                :options="ranges"
                :error="task.fields.value.rangeKind"
                :disabled="locked"
            />
            <task-config-field
                v-if="task.draft.rangeKind === 'rolling'"
                v-model="task.draft.days"
                label="向前查阅天数"
                kind="number"
                :error="task.fields.value.days"
                :disabled="locked"
            />
            <template v-else-if="task.draft.rangeKind === 'fixed'">
                <p class="text-muted break-anywhere m-0 [details_>_&:is(p)]:mt-4">
                    日期按 {{ browserTimezone }} 当地时间填写
                </p>
                <task-config-field
                    v-model="task.draft.start"
                    label="开始时间"
                    kind="date"
                    :error="task.fields.value.start"
                    :disabled="locked"
                />
                <task-config-field
                    v-model="task.draft.end"
                    label="结束时间"
                    kind="date"
                    :error="task.fields.value.end"
                    :disabled="locked"
                />
            </template>
            <output-format-select
                class="layout-grid gap-6 [border:0] m-0 p-0"
                v-model="selectedFormats"
                label="输出形式"
                :error="task.fields.value.outputFormats ?? task.fields.value.outputFormat"
                :disabled="locked"
            />
            <output-examples />
        </fieldset>
        <details
            class="min-w-0 [border-top:0.0625rem_solid_var(--scova-border)] pt-4"
            ref="sources"
        >
            <summary class="min-h-11 pt-2 pb-2 font-semibold cursor-pointer keyboard-focus">
                关注范围与来源偏好
            </summary>
            <div class="field-group grid gap-6 mt-4">
                <list-input
                    v-for="field in sourceFields"
                    :key="field.key"
                    v-model="task.draft[field.key]"
                    :label="field.label"
                    :url="field.url"
                    :hint="field.hint"
                    :placeholder="field.placeholder"
                    :add-label="field.addLabel"
                    :error="task.fields.value[field.key]"
                    :disabled="locked"
                />
                <task-config-field
                    v-model:checked="task.draft.officialOnly"
                    label="仅查阅官方来源"
                    kind="checkbox"
                    :error="task.fields.value.officialOnly"
                    :disabled="locked"
                />
                <p class="text-muted break-anywhere m-0 [details_>_&:is(p)]:mt-4">
                    每项可单独修改或删除；来源偏好不代表安全审核或官方身份认证。
                </p>
            </div>
        </details>
        <details
            class="min-w-0 [border-top:0.0625rem_solid_var(--scova-border)] pt-4"
            ref="budget"
            open
        >
            <summary class="min-h-11 pt-2 pb-2 font-semibold cursor-pointer keyboard-focus">
                单次执行预算
            </summary>
            <p class="text-muted break-anywhere m-0 [details_>_&:is(p)]:mt-4" v-if="legacyBudget">
                当前填写的预算低于新任务默认值。可按需调整后保存，再新建执行；重试旧执行仍使用原预算。
            </p>
            <div
                class="field-group budget-grid grid gap-6 mt-4 [@media(min-width:_40rem)]:grid-cols-[repeat(2,_minmax(0,_1fr))]"
            >
                <task-config-field
                    v-for="field in budgetFields"
                    :key="field.key"
                    v-model="task.draft[field.key]"
                    :label="field.label"
                    kind="number"
                    :error="task.fields.value[field.key]"
                    :disabled="locked"
                />
            </div>
            <info-dialog label="查看预算说明" title="执行预算与 Token 分配" wide>
                <task-token-budget
                    :input="Number(task.draft.maxInputTokens)"
                    :output="Number(task.draft.maxOutputTokens)"
                    :pages="Number(task.draft.maxPages)"
                />
                <p class="text-muted break-anywhere m-0 [details_>_&:is(p)]:mt-4">
                    预算按整次执行累计，包含规划、比较、综合和重试。时长最多{{
                        DEFAULT_TASK_BUDGET_LIMITS.maxDurationSeconds
                    }}秒，输入最多{{ DEFAULT_TASK_BUDGET_LIMITS.maxInputTokens }}、输出最多{{
                        DEFAULT_TASK_BUDGET_LIMITS.maxOutputTokens
                    }}
                    token。累计输出额度不等于简报篇幅；实际调用还受所选模型支持的上下文和输出上限约束。
                </p>
            </info-dialog>
        </details>
        <schedule-fields
            class="layout-grid gap-6 [border:0] m-0 p-0"
            v-model:frequency="task.draft.scheduleFrequency"
            v-model:timezone="task.draft.timezone"
            v-model:local-time="task.draft.scheduleLocalTime"
            v-model:weekday="task.draft.scheduleWeekday"
            :errors="task.fields.value"
            :disabled="locked"
            :saved="editor?.serverPlan.value"
            :dirty="task.dirty.value"
        />
        <fieldset class="layout-grid gap-6 [border:0] m-0 p-0" :disabled="locked">
            <legend class="text-[1.25rem] font-semibold mb-6 p-0">站内提醒</legend>
            <task-config-field
                v-model="task.draft.notificationMode"
                label="结果提醒"
                kind="select"
                :options="notifications"
                :error="task.fields.value.notificationMode"
                :disabled="locked"
            />
            <task-config-field
                v-model:checked="task.draft.runIssues"
                label="提醒失败或不完整执行"
                kind="checkbox"
                :error="task.fields.value.runIssues"
                :disabled="locked"
            />
        </fieldset>
        <p
            v-if="task.message.value && Object.keys(task.fields.value).length"
            class="save-error text-danger break-anywhere m-0 keyboard-focus [details_>_&:is(p)]:mt-4 [&.edit-warning]:([border:0.0625rem_solid_var(--scova-danger)] [border-left:0.25rem_solid_var(--scova-danger)] rounded-1.5 [background:var(--scova-selected)] p-5)"
            :class="{ 'edit-warning': !!editor }"
            role="alert"
            tabindex="-1"
        >
            {{ task.message.value }}
        </p>
        <section
            v-if="
                editor &&
                (editor.conflict.value || task.uncertain.value || editor.reloadRequested.value)
            "
            class="reload-panel layout-stack border-theme rounded-1.5 bg-surface p-5 [&.reload-panel_>_button]:justify-self-start"
            aria-label="重新读取任务"
        >
            <template v-if="editor.reloadRequested.value">
                <p class="text-muted break-anywhere m-0 [details_>_&:is(p)]:mt-4">
                    确认后会丢弃当前未保存草稿并读取最新配置。
                </p>
                <div class="save-actions flex items-center flex-wrap gap-[1rem_2rem]">
                    <action-button ref="reloadConfirm" :busy="task.pending.value" @click="reload"
                        >确认丢弃草稿并重新读取</action-button
                    >
                    <action-button :disabled="task.pending.value" @click="cancelReload"
                        >取消重新读取</action-button
                    >
                </div>
            </template>
            <action-button
                v-else
                ref="reloadStart"
                :disabled="task.pending.value || task.expired.value"
                @click="requestReload"
                >重新读取最新版本</action-button
            >
        </section>
        <div class="save-actions flex items-center flex-wrap gap-[1rem_2rem]">
            <action-button
                type="primary"
                attr-type="submit"
                :busy="task.pending.value"
                :disabled="
                    task.uncertain.value ||
                    task.expired.value ||
                    (editor &&
                        (editor.conflict.value ||
                            editor.blocked.value ||
                            !task.dirty.value ||
                            editor.reloadRequested.value))
                "
                >{{
                    task.pending.value ? '正在保存' : editor ? '确认保存修改' : '确认保存任务'
                }}</action-button
            >
            <router-link
                class="min-h-11 inline-flex items-center internal-link cursor-pointer keyboard-focus"
                v-if="initialResponse"
                :to="{ name: 'task-summary', params: { taskId: initialResponse.data.task.id } }"
                >返回任务摘要</router-link
            >
            <router-link
                class="min-h-11 inline-flex items-center internal-link cursor-pointer keyboard-focus"
                :to="{ name: 'tasks' }"
                >返回任务列表</router-link
            >
        </div>
        <p class="text-muted break-anywhere m-0 [details_>_&:is(p)]:mt-4" v-if="!editor">
            保存仅创建任务，不会开始执行。
        </p>
    </form>
</template>

<script setup lang="ts">
import InfoDialog from '@/components/common/InfoDialog.vue';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink } from 'vue-router';
import {
    DEFAULT_TASK_BUDGET,
    DEFAULT_TASK_BUDGET_LIMITS,
    type TaskDetailResponse,
} from '@scova/models';
import {
    createTaskController,
    editTaskController,
    budgetFields,
    type TaskDraftField,
} from '@/composables/useCreateTask';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import OutputFormatSelect from '@/components/tasks/OutputFormatSelect.vue';
import TaskTokenBudget from '@/components/tasks/TaskTokenBudget.vue';
import ListInput from '@/components/common/ListInput.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import ScheduleFields from '@/components/tasks/ScheduleFields.vue';
import OutputExamples from '@/components/tasks/OutputExamples.vue';
import { useActionNotification } from '@/composables/useActionNotification';
const notice = useActionNotification();
import type { ApiResponse } from '@/api/client';
const props = defineProps<{ initialResponse?: ApiResponse<TaskDetailResponse> }>();
import NaturalLanguageDraft from '@/components/tasks/NaturalLanguageDraft.vue';
import TaskExecutionSettings from '@/components/tasks/TaskExecutionSettings.vue';
const emit = defineEmits<{ saved: [result: TaskDetailResponse] }>();
const lifecycle = useSessionLifecycle();
const editor = props.initialResponse
    ? editTaskController(lifecycle, props.initialResponse)
    : undefined;
const creator = editor ? undefined : createTaskController(lifecycle);
const task = editor ?? creator!;
notice.watch(
    () => (Object.keys(task.fields.value).length ? '' : task.message.value),
    () => (task.uncertain.value || task.expired.value ? 'warning' : 'error'),
);
const selectedFormats = computed({
    get: () =>
        task.draft.outputFormats.length
            ? task.draft.outputFormats
            : [task.draft.outputFormat as import('@scova/models').OutputFormat],
    set: (formats: import('@scova/models').OutputFormat[]) => {
        task.draft.outputFormats = formats;
        task.draft.outputFormat = formats[0] ?? 'brief';
    },
});
const legacyBudget = computed(
    () =>
        Boolean(editor) &&
        (Number(task.draft.maxInputTokens) < DEFAULT_TASK_BUDGET.maxInputTokens ||
            Number(task.draft.maxOutputTokens) < DEFAULT_TASK_BUDGET.maxOutputTokens),
);
const locked = computed(() => task.pending.value || task.uncertain.value || task.expired.value);
const form = ref<HTMLFormElement>();
const reloadStart = ref<InstanceType<typeof ActionButton>>();
const reloadConfirm = ref<InstanceType<typeof ActionButton>>();
function focusButton(button: InstanceType<typeof ActionButton> | undefined) {
    (button?.$el as HTMLElement | undefined)?.focus();
}
async function requestReload() {
    if (!editor || task.pending.value) return;
    editor.reloadRequested.value = true;
    await nextTick();
    focusButton(reloadConfirm.value);
}
async function cancelReload() {
    if (!editor || task.pending.value) return;
    editor.reloadRequested.value = false;
    await nextTick();
    focusButton(reloadStart.value);
}
async function reload() {
    if (!editor) return;
    await editor.reload();
    await nextTick();
    if (editor.reloadRequested.value) focusButton(reloadConfirm.value);
    else form.value?.querySelector<HTMLElement>('fieldset input')?.focus();
}
const sources = ref<HTMLDetailsElement>();
const budget = ref<HTMLDetailsElement>();
const mainFields = [
    { key: 'title', label: '任务标题', kind: 'text' },
    { key: 'topic', label: '查阅主题', kind: 'textarea' },
    { key: 'goal', label: '查阅目标', kind: 'textarea' },
] as const;
const sourceFields = [
    {
        key: 'focusPoints',
        label: '重点关注（可选）',
        url: false,
        hint: '添加关键词、问题或需要持续关注的内容。Enter 新增，Shift+Enter 换行。',
        placeholder: '例如：费用变化、申请资格',
        addLabel: '添加关注点',
    },
    {
        key: 'exclusions',
        label: '排除主题或条件（可选）',
        url: false,
        hint: '列出不需要纳入研究的内容。',
        placeholder: '例如：商业广告、重复转载',
        addLabel: '添加排除条件',
    },
    {
        key: 'preferredUrls',
        label: '优先来源网址（可选）',
        url: true,
        hint: '优先查看的官网或具体页面，一项一个链接。',
        placeholder: 'https://example.com',
        addLabel: '添加优先链接',
    },
    {
        key: 'excludedUrls',
        label: '排除来源网址（可选）',
        url: true,
        hint: '不希望查阅的网页，一项一个链接。',
        placeholder: 'https://example.com',
        addLabel: '添加排除链接',
    },
] as const;
const ranges = computed(() => [
    { value: 'rolling', label: '滚动范围' },
    { value: 'fixed', label: '固定范围' },
    ...(task.draft.researchMode === 'analysis'
        ? [{ value: 'unbounded', label: '不限日期（可选）' }]
        : []),
]);
const researchModes = [
    {
        value: 'collection',
        label: '资料采集',
        description: '仅收录日期在窗口内、有直接原文出处的值；不使用模型补答。',
    },
    {
        value: 'analysis',
        label: '分析研究',
        description: '综合证据与推论；允许标注为模型回答，日期窗口可选。',
    },
];
const unknownDateOptions = [
    { value: 'separate', label: '单列展示，不计入采集结果' },
    { value: 'discard', label: '直接剔除' },
];
function selectResearchMode(mode: string) {
    if (mode !== 'collection') return;
    if (task.draft.rangeKind === 'unbounded') {
        task.draft.rangeKind = 'rolling';
        task.draft.days = '7';
    }
    task.draft.outputFormats = ['list'];
    task.draft.outputFormat = 'list';
}
const notifications = [
    { value: 'summary', label: '每次汇总' },
    { value: 'important_change', label: '仅重要变化' },
    { value: 'off', label: '关闭结果提醒' },
];
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
async function enterManualConfiguration() {
    await focusConfiguration();
}
async function focusConfiguration() {
    await nextTick();
    const input = form.value?.querySelector<HTMLElement>('fieldset input');
    input?.focus();
    input?.scrollIntoView({ block: 'center' });
}
async function save() {
    const result = await task.submit();
    if (result) {
        notice.success(
            editor ? '任务修改已保存' : '任务已创建',
            editor?.result.value?.baselineResetRequired
                ? '修改了查阅范围，下次执行会重新设定比较起点；历史报告不变'
                : editor
                  ? '保存不会开始执行研究。'
                  : '保存不会开始执行研究。',
        );
        emit('saved', result);
    } else if (task.message.value) {
        const invalid = Object.keys(task.fields.value) as TaskDraftField[];
        if (invalid.some((key) => sourceFields.some((field) => field.key === key)) && sources.value)
            sources.value.open = true;
        if (invalid.some((key) => budgetFields.some((field) => field.key === key)) && budget.value)
            budget.value.open = true;
        await nextTick();
        // 按页面顺序找第一个错误，不依赖服务端错误数组的顺序。
        const first = form.value?.querySelector<HTMLElement>('[aria-invalid="true"]');
        if (first) first.focus();
        else if (editor && !task.expired.value) focusButton(reloadStart.value);
    }
}
onBeforeRouteLeave(() =>
    task.canLeave(() => window.confirm('任务尚未保存，确定离开并放弃填写内容？')),
);
onBeforeRouteUpdate(() =>
    task.canLeave(() => window.confirm('任务尚未保存，确定离开并放弃填写内容？')),
);
function beforeUnload(event: BeforeUnloadEvent) {
    if (task.expired.value || (!editor && task.saved.value)) return;
    if (!task.dirty.value && !task.pending.value && !task.uncertain.value) return;
    event.preventDefault();
    event.returnValue = '';
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onUnmounted(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    task.dispose();
});
</script>
