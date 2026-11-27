<template>
    <div v-if="report" class="artifact-selection scova-interface">
        <label for="conversation-artifact-select" class="sr-only">成果版本</label>
        <select
            id="conversation-artifact-select"
            class="artifact-select"
            :value="selectedArtifactId || report?.id"
            @change="emit('select', ($event.target as HTMLSelectElement).value)"
        >
            <option v-if="report" :value="report.id">
                原报告 · {{ outputFormatLabels[report.format] }}
            </option>
            <option
                v-for="artifact in conversationArtifacts"
                :key="artifact.reportId"
                :value="artifact.reportId"
            >
                {{ artifact.round ? `第 ${artifact.round} 轮` : '后续成果' }} ·
                {{
                    artifact.operation === 'merge'
                        ? '合并'
                        : artifact.operation === 'revise'
                          ? '改写'
                          : '补查'
                }}
                ·
                {{ artifact.title }}
            </option>
        </select>
    </div>
</template>
<script setup lang="ts">
import { outputFormatLabels, type Report, type ReportConversation } from '@scova/models';
type ConversationArtifact = NonNullable<ReportConversation['artifacts']>[number];
defineProps<{
    report?: Report;
    selectedArtifactId: string;
    conversationArtifacts: ConversationArtifact[];
}>();
const emit = defineEmits<{ select: [id: string] }>();
</script>
<style scoped>
.artifact-selection {
    min-width: 0;
}
.artifact-selection .artifact-select:not([multiple]) {
    display: block;
    width: 100%;
    max-width: 14rem;
    min-height: 2.25rem;
    min-block-size: 2.25rem;
    padding: 0.375rem 1.75rem 0.375rem 0.5rem;
    overflow: hidden;
    border: 0;
    border-radius: 0.5rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    font: inherit;
    font-size: 1rem;
    text-overflow: ellipsis;
    cursor: pointer;
}
.artifact-selection .artifact-select:not(:disabled):hover {
    background: var(--scova-selected);
}
.artifact-selection .artifact-select:not(:disabled):focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -1px;
    box-shadow: none;
}
@media (pointer: coarse) {
    .artifact-select {
        min-height: 2.75rem;
    }
}
</style>
