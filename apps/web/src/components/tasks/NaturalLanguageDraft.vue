<template>
    <section
        ref="panel"
        class="natural-language-draft scova-surface"
        aria-labelledby="natural-draft-title"
    >
        <h2 id="natural-draft-title">从描述生成草稿</h2>
        <p>可选。先描述需求，再检查草稿；也可以直接手工填写。解析不会保存任务或开始研究。</p>
        <task-config-field
            v-model="task.inputText.value"
            label="原始需求描述"
            kind="textarea"
            :error="draft.inputError.value"
            :disabled="draft.unavailable.value"
        />
        <p>最多 2000 个字符、8000 UTF-8 字节，原文会保留，不会自动重发解析请求。</p>
        <div @keydown.enter.prevent="parse">
            <task-config-field
                v-model="draft.timezone.value"
                label="解析时区（可选，IANA）"
                :error="draft.timezoneError.value"
                :disabled="draft.unavailable.value"
            />
        </div>
        <p>留空时按原文明确时区或账号默认时区解析，应用后仍可在表单中修改。</p>
        <div class="draft-buttons">
            <action-button
                :disabled="draft.unavailable.value"
                :busy="draft.pending.value"
                @click="parse"
                ><app-icon name="edit" />{{
                    draft.pending.value ? '正在解析' : '解析为草稿'
                }}</action-button
            >
            <action-button v-if="draft.pending.value" @click="cancel">停止解析</action-button>
            <action-button :disabled="draft.unavailable.value" @click="emit('manual')"
                >直接手工填写</action-button
            >
        </div>
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
                {{ draft.result.value.mode === 'model' ? '模型解析草稿' : '手工编辑草稿' }}
            </h3>
            <p v-if="draft.result.value.manualReason">
                {{ manualReasons[draft.result.value.manualReason] }}
            </p>
            <p v-if="draft.result.value.mode === 'manual'">
                这是待手工确认的配置，未使用演示研究资料。
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
            <section aria-label="独立解析用量" class="parsing-usage">
                <h3>独立解析用量</h3>
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
                    }}不计入任何 Run 预算。
                </p>
            </section>
            <p v-if="draft.stale.value" class="stale-warning">
                原文、解析时区或表单已变化，此结果不能覆盖当前配置。请重新解析或继续手工填写。
            </p>
            <action-button :disabled="!draft.canApply.value" @click="apply"
                ><app-icon name="confirm" />应用草稿并替换当前配置</action-button
            >
        </section>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import type { createTaskController } from '@/composables/useCreateTask';
import { taskScheduleDescription } from '@/composables/useCreateTask';
import { useNaturalLanguageDraft } from '@/composables/useNaturalLanguageDraft';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
const props = defineProps<{ task: ReturnType<typeof createTaskController> }>();
const emit = defineEmits<{ applied: []; manual: [] }>();
const draft = useNaturalLanguageDraft(props.task);
const panel = ref<HTMLElement>();
const feedback = ref<HTMLElement>();
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
        focusPoints: '重点关注',
        exclusions: '排除条件',
        title: '标题',
        topic: '主题',
        goal: '目标',
    };
    return labels[key ?? ''] ?? '配置';
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
.draft-result,
.parsing-usage {
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
