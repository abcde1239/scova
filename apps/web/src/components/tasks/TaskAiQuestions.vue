<template>
    <section class="ai-questions" aria-labelledby="ai-questions-title">
        <h3 id="ai-questions-title" ref="heading" tabindex="-1">
            AI 正在与你确认需求 · {{ result.round + 1 }}/3
        </h3>
        <p>{{ result.summary }}</p>
        <details v-if="transcript.length">
            <summary>已确认的回答（{{ transcript.length }} 项）</summary>
            <dl>
                <template v-for="(item, index) in transcript" :key="index"
                    ><dt>{{ item.question }}</dt>
                    <dd>{{ item.answer }}</dd></template
                >
            </dl>
        </details>
        <fieldset
            v-for="question in result.questions"
            :key="question.id"
            :disabled="disabled || busy"
        >
            <legend>{{ question.question }}</legend>
            <p class="muted">{{ question.reason }}</p>
            <div v-if="question.options.length" class="answer-options">
                <action-button
                    v-for="option in question.options"
                    :key="option"
                    :disabled="disabled || busy"
                    @click="answers[question.id] = option"
                    >{{ option }}</action-button
                >
            </div>
            <task-config-field
                v-model="answers[question.id]"
                :label="`你的回答：${question.question}`"
                kind="textarea"
                :disabled="disabled || busy"
            />
        </fieldset>
        <p v-if="message" role="status">{{ message }}</p>
        <state-panel
            v-if="busy"
            state="loading"
            message="AI 正在结合回答继续整理需求，可随时停止。"
        />
        <div class="question-actions">
            <action-button
                :busy="busy"
                :disabled="disabled || busy"
                @click="emit('answer', { ...answers })"
                >继续与 AI 确认</action-button
            >
            <action-button @click="emit('cancel')">{{
                busy ? '停止解析' : '返回需求描述'
            }}</action-button>
            <action-button :disabled="disabled" @click="emit('manual')">手动填写</action-button>
        </div>
    </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { TaskClarifications, TaskDraftQuestionsResponse } from '@scova/models';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import StatePanel from '@/components/common/StatePanel.vue';
defineProps<{
    result: TaskDraftQuestionsResponse;
    transcript: TaskClarifications;
    busy: boolean;
    disabled: boolean;
    message: string;
}>();
const emit = defineEmits<{ answer: [answers: Record<string, string>]; cancel: []; manual: [] }>();
const answers = reactive<Record<string, string>>({});
const heading = ref<HTMLElement>();
onMounted(() => heading.value?.focus());
</script>

<style scoped>
.ai-questions,
fieldset,
dl {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
}
h3,
p,
dl,
dd {
    margin: 0;
    overflow-wrap: anywhere;
}
fieldset {
    border: 0;
    padding: 0;
}
legend {
    font-weight: 600;
    padding: 0;
    margin-block-end: 0.75rem;
}
.muted,
dt {
    color: var(--scova-muted);
}
.answer-options,
.question-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
}
.answer-options :deep(button) {
    white-space: normal;
    text-align: start;
    max-inline-size: 100%;
}
h3:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
