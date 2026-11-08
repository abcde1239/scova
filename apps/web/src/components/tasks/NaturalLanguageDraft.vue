<template>
    <section
        ref="panel"
        class="natural-language-draft scova-surface"
        aria-labelledby="natural-draft-title"
    >
        <div class="draft-heading">
            <h2 id="natural-draft-title">用 AI 整理需求</h2>
            <info-dialog label="如何创建任务" title="AI 整理与手动填写">
                <p>
                    AI 整理：描述想研究的内容，由需求整理 Agent
                    建议标题、关注重点和执行计划，再由你检查、修改。
                </p>
                <p>
                    手动填写：直接填写下方的任务配置，不调用需求整理
                    Agent。两种方式最终创建的是同一种任务。
                </p>
                <p>
                    生成和应用草稿都不会保存任务或开始研究。检查表单并保存后，任务才会创建；研究由研究执行
                    Agent 负责。
                </p>
                <p>
                    需求时区用于理解描述中的时间，默认沿用当前任务时区；也可以从列表另选。应用草稿后仍可修改执行计划。
                </p>
            </info-dialog>
        </div>
        <div v-if="manualMode" class="draft-result">
            <p role="status">
                已进入手工配置。直接填写下方标题、目标、范围和输出形式，再保存任务。
            </p>
            <action-button
                @click="
                    manualMode = false;
                    draft.message.value = '';
                "
                >返回 AI 整理需求</action-button
            >
        </div>
        <task-scope-questions
            v-else-if="questionsVisible"
            :input-text="task.inputText.value"
            :format="task.draft.outputFormat"
            :mode="task.draft.researchMode"
            :initial="draft.searchScope.value"
            :disabled="draft.unavailable.value || draft.pending.value"
            @confirm="confirmScope"
            @cancel="questionsVisible = false"
        />
        <template v-else>
            <p>描述需求后，先通过三步问答确认搜索内容、来源与时间、交付形式，再由 AI 生成配置。</p>
            <task-config-field
                v-model="task.inputText.value"
                label="需求描述"
                kind="textarea"
                :error="draft.inputError.value"
                :disabled="draft.unavailable.value"
            />
            <p class="input-hint">最多 2000 字</p>
            <task-config-field
                v-model="draft.timezone.value"
                label="需求时区"
                kind="select"
                searchable
                :options="timezones"
                :error="draft.timezoneError.value"
                :disabled="draft.unavailable.value"
            />
            <div class="draft-buttons">
                <action-button
                    :disabled="draft.unavailable.value"
                    :busy="draft.pending.value"
                    @click="openQuestions"
                    ><app-icon name="edit" />{{
                        draft.pending.value ? '正在整理' : '生成任务草稿'
                    }}</action-button
                >
                <action-button v-if="draft.pending.value" @click="cancel">停止解析</action-button>
                <action-button :disabled="draft.unavailable.value" @click="enterManual"
                    >手动填写</action-button
                >
            </div>
            <state-panel
                v-if="draft.pending.value"
                state="loading"
                message="正在整理需求与生成建议配置，可随时停止解析。"
            />
            <div
                v-if="draft.message.value"
                ref="feedback"
                class="draft-feedback"
                role="status"
                aria-live="polite"
                tabindex="-1"
            >
                <p>{{ draft.message.value }}</p>
            </div>
            <section
                v-if="draft.result.value"
                class="draft-result"
                aria-labelledby="draft-result-title"
            >
                <h3 id="draft-result-title">
                    {{ draft.result.value.mode === 'model' ? '建议配置' : '待完善的配置' }}
                </h3>
                <p v-if="draft.result.value.manualReason">
                    {{ manualReasons[draft.result.value.manualReason] }}
                </p>
                <details>
                    <summary>本次解析原文</summary>
                    <p class="original-text">{{ draft.result.value.inputText }}</p>
                </details>
                <ul v-if="draft.result.value.warnings.length" aria-label="解析警告">
                    <li v-for="(warning, index) in draft.result.value.warnings" :key="index">
                        {{ warningLabel(warning.path) }}：{{ warning.message }}
                    </li>
                </ul>
                <dl class="draft-preview">
                    <div>
                        <dt>建议标题</dt>
                        <dd>{{ draft.result.value.config.title }}</dd>
                    </div>
                    <div>
                        <dt>建议计划</dt>
                        <dd>{{ taskScheduleDescription(draft.result.value.config) }}</dd>
                    </div>
                    <div>
                        <dt>执行预算</dt>
                        <dd>
                            搜索 {{ draft.result.value.config.budget.maxSearches }} 次，读取
                            {{ draft.result.value.config.budget.maxPages }} 页，时长
                            {{ draft.result.value.config.budget.maxDurationSeconds }} 秒，输入
                            {{ draft.result.value.config.budget.maxInputTokens }} token，输出
                            {{ draft.result.value.config.budget.maxOutputTokens }} token
                        </dd>
                    </div>
                </dl>
                <info-dialog label="查看生成详情" title="本次草稿生成详情">
                    <p>
                        模型调用 {{ draft.result.value.parsingUsage.attempts }} 次 · 输入
                        {{ draft.result.value.parsingUsage.inputTokens }} token · 输出
                        {{ draft.result.value.parsingUsage.outputTokens }} token
                    </p>
                    <p>
                        {{
                            draft.result.value.parsingUsage.estimated
                                ? '包含保守预留或估算用量。'
                                : '当前解析用量未标记估算。'
                        }}用量独立统计，不计入后续研究预算。
                    </p>
                </info-dialog>
                <p v-if="draft.stale.value" class="stale-warning">
                    原文、解析时区或表单已变化，此结果不能覆盖当前配置。请重新解析或继续手工填写。
                </p>
                <action-button :disabled="!draft.canApply.value" @click="apply"
                    ><app-icon name="confirm" />应用草稿并替换当前配置</action-button
                >
            </section>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { createTaskController } from '@/composables/useCreateTask';
import { taskScheduleDescription } from '@/composables/useCreateTask';
import { useNaturalLanguageDraft } from '@/composables/useNaturalLanguageDraft';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import InfoDialog from '@/components/common/InfoDialog.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import TaskScopeQuestions from '@/components/tasks/TaskScopeQuestions.vue';
import { validateDraftInput } from '@/api/task-drafts';
import type { TaskDraftScope } from '@scova/models';
import { timezoneOptions } from '@/utils/timezones';
const props = defineProps<{ task: ReturnType<typeof createTaskController> }>();
const emit = defineEmits<{ applied: []; manual: [] }>();
const draft = useNaturalLanguageDraft(props.task);
const timezones = computed(() => timezoneOptions(draft.timezone.value));
const panel = ref<HTMLElement>();
const feedback = ref<HTMLElement>();
const questionsVisible = ref(false);
const manualMode = ref(false);
const manualReasons = {
    model_unavailable: '当前未配置可用模型，请手工编辑并确认配置。',
    ambiguous_timezone: '原文包含不同明确时区，请手工确认时区与计划。',
    invalid_output: '解析配置未通过校验，请根据原文手工编辑。',
    timeout: '草稿解析超时，请手工编辑。',
    aborted: '草稿解析已停止，请手工编辑。',
    budget_exceeded: '独立解析预算已用尽，请手工编辑。',
    model_failed: '模型暂时无法解析，请手工编辑。',
};
function warningLabel(path: string) {
    const key = path.replace(/^\/config\/?/, '').split('/')[0];
    const labels: Record<string, string> = {
        schedule: '计划',
        budget: '预算',
        timezone: '时区',
        sourcePreferences: '来源偏好',
        timeRange: '查阅范围',
        notificationPreference: '提醒',
        outputFormat: '输出形式',
        researchMode: '任务方式',
        focusPoints: '重点关注',
        exclusions: '排除条件',
        title: '标题',
        topic: '主题',
        goal: '目标',
    };
    return labels[key ?? ''] ?? '配置';
}
async function openQuestions() {
    if (draft.pending.value || draft.unavailable.value) return;
    try {
        validateDraftInput({ inputText: props.task.inputText.value });
    } catch {
        await parse();
        return;
    }
    questionsVisible.value = true;
    await nextTick();
    panel.value?.querySelector<HTMLElement>('.scope-questions h3')?.focus();
}
async function confirmScope(scope: TaskDraftScope) {
    draft.searchScope.value = scope;
    questionsVisible.value = false;
    await parse();
}
function enterManual() {
    draft.cancel();
    questionsVisible.value = false;
    manualMode.value = true;
    emit('manual');
}
async function parse() {
    const origin = document.activeElement;
    await draft.parse();
    await nextTick();
    if (
        draft.stale.value ||
        (document.activeElement !== origin && document.activeElement !== document.body)
    )
        return;
    const invalid = panel.value?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalid) invalid.focus();
    else feedback.value?.focus();
}
function apply() {
    if (draft.apply()) emit('applied');
}
async function cancel() {
    draft.cancel();
    await nextTick();
    feedback.value?.focus();
}
</script>

<style scoped>
.natural-language-draft,
.draft-result {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
}
.natural-language-draft {
    padding: clamp(1rem, 3%, 1.5rem);
    border-radius: 0.75rem;
    overflow-wrap: anywhere;
}
h2,
h3,
p {
    margin: 0;
}
h2 {
    font-size: 1.25rem;
    line-height: 1.5;
}
h3 {
    font-size: 1.125rem;
    line-height: 1.5;
}
.draft-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
}
.draft-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
}
.input-hint {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.draft-result {
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block-start: 1.25rem;
}
.draft-result > :deep(.scova-action-button) {
    justify-self: start;
}
.original-text {
    white-space: pre-wrap;
    margin-block-start: 1rem;
}
summary {
    cursor: pointer;
    min-block-size: 2.75rem;
    padding-block: 0.5rem;
}
.draft-feedback:focus-visible,
summary:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
ul {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding-inline-start: 1.25rem;
}
.draft-preview {
    display: grid;
    gap: 1rem;
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0.25rem 0 0;
}
.stale-warning {
    color: var(--scova-partial);
}
</style>
