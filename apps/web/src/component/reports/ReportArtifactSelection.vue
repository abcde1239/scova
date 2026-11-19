<template>
    <div class="artifact-selection scova-interface">
        <label for="conversation-artifact-select">成果</label>
        <select
            id="conversation-artifact-select"
            class="report-select"
            :value="selectedArtifactId || report?.id"
            @change="emit('select', ($event.target as HTMLSelectElement).value)"
        >
            <option v-if="report" :value="report.id">原报告 · {{ report.title }}</option>
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
        <button
            v-if="report?.mode === 'live' && conversationArtifacts.length"
            type="button"
            class="open-current-artifact report-open-button"
            @click="emit('merge', selectedArtifact?.reportId)"
        >
            合并到原报告
        </button>
        <p
            v-if="selectedArtifactId && selectedArtifactId !== report?.id"
            class="text-muted text-xs m-0"
        >
            {{
                selectedArtifact?.round
                    ? `来自第 ${selectedArtifact.round} 轮`
                    : '来自本报告后续对话'
            }}
            · 讨论仍基于原报告
        </p>
    </div>
</template>
<script setup lang="ts">
import type { Report, ReportConversation } from '@scova/models';
type ConversationArtifact = NonNullable<ReportConversation['artifacts']>[number];
defineProps<{
    report?: Report;
    selectedArtifactId: string;
    selectedArtifact?: ConversationArtifact;
    conversationArtifacts: ConversationArtifact[];
}>();
const emit = defineEmits<{ select: [id: string]; merge: [id?: string] }>();
</script>
<style scoped>
.artifact-selection {
    @apply grid gap-2 min-w-0;
}
.artifact-selection label {
    @apply text-sm text-muted;
}
</style>
