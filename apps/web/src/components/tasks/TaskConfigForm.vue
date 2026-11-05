<template>
    <form
        ref="form"
        class="task-config-form"
        novalidate
        :aria-busy="task.pending.value"
        @submit.prevent="save"
    >
        <template v-if="editor">
            <p>配置版本 {{ editor.revision.value }}。保存创建新版本，不开始执行，历史保持原样。</p>
            <p>查阅范围变化后，下次完整执行将建立新基线，以保存结果为准。</p>
            <p
                v-if="editor.result.value && task.saved.value"
                role="status"
                class="save-success"
                tabindex="-1"
                ref="successMessage"
            >
                修改已保存。{{
                    editor.result.value.baselineResetRequired
                        ? '语义查阅范围已变化，下一次完整执行将建立新基线。'
                        : '本次保存无需重置比较基线。'
                }}历史执行与报告保持原样。
            </p>
            <section
                class="reload-panel"
                :class="{ 'reload-panel--confirm': editor.reloadRequested.value }"
                aria-label="重新读取任务"
            >
                <template v-if="editor.reloadRequested.value">
                    <p>
                        确认后会丢弃当前未保存草稿，读取服务器最新配置与修订依据。可以先复制需要手动合并的内容。
                    </p>
                    <div class="save-actions">
                        <action-button
                            ref="reloadConfirm"
                            :busy="task.pending.value"
                            @click="reload"
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
        </template>
        <natural-language-draft
            v-if="creator"
            :task="creator"
            @applied="focusConfiguration"
            @manual="focusConfiguration"
        />
        <fieldset :disabled="locked">
            <legend>查阅任务</legend>
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
        <fieldset :disabled="locked">
            <legend>时间与输出</legend>
            <task-config-field
                v-model="task.draft.rangeKind"
                label="查阅时间范围"
                kind="select"
                :options="ranges"
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
            <template v-else>
                <p>日期按 {{ browserTimezone }} 当地时间填写</p>
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
            <task-config-field
                v-model="task.draft.outputFormat"
                label="输出形式"
                kind="select"
                :options="outputs"
                :error="task.fields.value.outputFormat"
                :disabled="locked"
            />
            <output-examples />
        </fieldset>
        <details ref="sources">
            <summary>关注范围与来源偏好</summary>
            <div class="field-group">
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
                <p>每项可单独修改或删除；来源偏好不代表安全审核或官方身份认证。</p>
            </div>
        </details>
        <details ref="budget" open>
            <summary>单次执行预算</summary>
            <div class="field-group budget-grid">
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
            <p>
                预算按整次执行累计，包含规划、比较、综合和重试。时长最多{{
                    DEFAULT_TASK_BUDGET_LIMITS.maxDurationSeconds
                }}秒，输入最多{{ DEFAULT_TASK_BUDGET_LIMITS.maxInputTokens }}、输出最多{{
                    DEFAULT_TASK_BUDGET_LIMITS.maxOutputTokens
                }}
                token。累计输出额度不等于简报篇幅；实际调用还受所选模型支持的上下文和输出上限约束。
            </p>
        </details>
        <schedule-fields
            v-model:frequency="task.draft.scheduleFrequency"
            v-model:timezone="task.draft.timezone"
            v-model:local-time="task.draft.scheduleLocalTime"
            v-model:weekday="task.draft.scheduleWeekday"
            :errors="task.fields.value"
            :disabled="locked"
            :saved="editor?.serverPlan.value"
            :dirty="task.dirty.value"
        />
        <fieldset :disabled="locked">
            <legend>站内提醒</legend>
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
            v-if="task.message.value"
            ref="errorMessage"
            class="save-error"
            :class="{ 'edit-warning': !!editor }"
            role="alert"
            tabindex="-1"
        >
            {{ task.message.value }}
        </p>
        <div class="save-actions">
            <action-button
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
                v-if="initialResponse"
                :to="{ name: 'task-summary', params: { taskId: initialResponse.data.task.id } }"
                >返回任务摘要</router-link
            >
            <router-link :to="{ name: 'tasks' }">返回任务列表</router-link>
        </div>
        <p v-if="!editor">保存仅创建任务，不会开始执行。</p>
    </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink } from 'vue-router';
import { DEFAULT_TASK_BUDGET_LIMITS, type TaskDetailResponse } from '@scova/models';
import {
    createTaskController,
    editTaskController,
    budgetFields,
    type TaskDraftField,
} from '@/composables/useCreateTask';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import ListInput from '@/components/common/ListInput.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import ScheduleFields from '@/components/tasks/ScheduleFields.vue';
import OutputExamples from '@/components/tasks/OutputExamples.vue';
import { useActionNotification } from '@/composables/useActionNotification';
const notice = useActionNotification();
import type { ApiResponse } from '@/api/client';
const props = defineProps<{ initialResponse?: ApiResponse<TaskDetailResponse> }>();
import NaturalLanguageDraft from '@/components/tasks/NaturalLanguageDraft.vue';
const emit = defineEmits<{ saved: [result: TaskDetailResponse] }>();
const lifecycle = useSessionLifecycle();
const editor = props.initialResponse
    ? editTaskController(lifecycle, props.initialResponse)
    : undefined;
const creator = editor ? undefined : createTaskController(lifecycle);
const task = editor ?? creator!;
const locked = computed(() => task.pending.value || task.uncertain.value || task.expired.value);
const form = ref<HTMLFormElement>();
const errorMessage = ref<HTMLParagraphElement>();
const successMessage = ref<HTMLParagraphElement>();
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
    if (editor.reloadRequested.value) errorMessage.value?.focus();
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
const ranges = [
    { value: 'rolling', label: '滚动范围' },
    { value: 'fixed', label: '固定范围' },
];
const outputs = [
    { value: 'brief', label: '简报' },
    { value: 'list', label: '主题清单' },
    { value: 'comparison', label: '对比表' },
    { value: 'research_report', label: '研究报告' },
];
const notifications = [
    { value: 'summary', label: '每次汇总' },
    { value: 'important_change', label: '仅重要变化' },
    { value: 'off', label: '关闭结果提醒' },
];
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
async function focusConfiguration() {
    await nextTick();
    form.value?.querySelector<HTMLElement>('fieldset input')?.focus();
}
async function save() {
    const result = await task.submit();
    if (result) {
        notice.success(editor ? '任务修改已保存' : '任务已创建', '保存不会开始执行研究。');
        emit('saved', result);
        if (editor) {
            await nextTick();
            successMessage.value?.focus();
        }
    } else if (task.message.value) {
        const invalid = Object.keys(task.fields.value) as TaskDraftField[];
        if (!invalid.length && !task.expired.value) {
            if (task.uncertain.value) notice.warning('保存结果未确认', task.message.value);
            else notice.error('任务未保存', task.message.value);
        }
        if (invalid.some((key) => sourceFields.some((field) => field.key === key)) && sources.value)
            sources.value.open = true;
        if (invalid.some((key) => budgetFields.some((field) => field.key === key)) && budget.value)
            budget.value.open = true;
        await nextTick();
        // 按页面顺序找第一个错误，不依赖服务端错误数组的顺序。
        const first = form.value?.querySelector<HTMLElement>('[aria-invalid="true"]');
        if (first) first.focus();
        else errorMessage.value?.focus();
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

<style scoped>
.task-config-form {
    inline-size: min(100%, 44rem);
    min-inline-size: 0;
    display: grid;
    gap: 2.5rem;
    cursor: default;
}
fieldset {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    border: 0;
    margin: 0;
    padding: 0;
}
legend {
    font-size: 1.25rem;
    font-weight: 600;
    padding: 0;
    margin-block-end: 1.5rem;
}
details {
    min-inline-size: 0;
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block-start: 1rem;
}
summary {
    min-block-size: 2.75rem;
    padding-block: 0.5rem;
    font-weight: 600;
    cursor: pointer;
}
.field-group {
    display: grid;
    gap: 1.5rem;
    margin-block-start: 1rem;
}
p {
    margin: 0;
    color: var(--scova-muted);
    overflow-wrap: anywhere;
}
details > p {
    margin-block-start: 1rem;
}
.save-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem 2rem;
}
a {
    min-block-size: 2.75rem;
    display: inline-flex;
    align-items: center;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
.save-error {
    color: var(--scova-danger);
}
.edit-warning {
    padding: 1.25rem;
    border: 0.0625rem solid var(--scova-danger);
    border-inline-start: 0.25rem solid var(--scova-danger);
    border-radius: 0.375rem;
    background: var(--scova-selected);
}
.reload-panel {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
}
.reload-panel--confirm {
    padding: 1.25rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.375rem;
    background: var(--scova-surface);
}
.reload-panel > :deep(button) {
    justify-self: start;
}
.save-success {
    color: var(--scova-text);
    padding: 1rem;
    border-inline-start: 0.25rem solid var(--scova-primary);
    background: var(--scova-surface);
}
.save-success:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
a:focus-visible,
summary:focus-visible,
.save-error:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
@media (min-width: 40rem) {
    .budget-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
</style>
