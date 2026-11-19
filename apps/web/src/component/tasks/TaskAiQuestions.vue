<template>
    <section class="ai-questions layout-stack" aria-labelledby="ai-questions-title">
        <h3
            class="break-anywhere m-0 keyboard-focus-wide"
            id="ai-questions-title"
            ref="heading"
            tabindex="-1"
        >
            AI 正在与你确认需求 · {{ result.round + 1 }}/3
        </h3>
        <p class="break-anywhere m-0">{{ result.summary }}</p>
        <details v-if="transcript.length">
            <summary>已确认的回答（{{ transcript.length }} 项）</summary>
            <dl class="layout-stack break-anywhere m-0">
                <template v-for="(item, index) in transcript" :key="index"
                    ><dt class="text-muted">{{ item.question }}</dt>
                    <dd class="break-anywhere m-0">{{ item.answer }}</dd></template
                >
            </dl>
        </details>
        <fieldset
            class="layout-stack [border:0] p-0"
            v-for="question in result.questions"
            :key="question.id"
            :disabled="disabled || busy"
        >
            <legend class="font-semibold mb-3 p-0">{{ question.question }}</legend>
            <p class="muted break-anywhere text-muted m-0">{{ question.reason }}</p>
            <div
                v-if="question.options.length"
                class="answer-options action-group [&.answer-options_button]:(whitespace-normal text-start max-w-full)"
            >
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
        <state-panel
            v-if="busy"
            state="loading"
            message="AI 正在结合回答继续整理需求，可随时停止。"
        />
        <div class="question-actions action-group">
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
import TaskConfigField from '@/component/tasks/TaskConfigField.vue';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
defineProps<{
    result: TaskDraftQuestionsResponse;
    transcript: TaskClarifications;
    busy: boolean;
    disabled: boolean;
}>();
const emit = defineEmits<{ answer: [answers: Record<string, string>]; cancel: []; manual: [] }>();
const answers = reactive<Record<string, string>>({});
const heading = ref<HTMLElement>();
onMounted(() => heading.value?.focus());
</script>
