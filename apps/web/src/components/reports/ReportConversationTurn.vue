<template>
    <article class="conversation-turn">
        <div class="user-message">
            <p class="message-label">你的问题</p>
            <p>{{ turn.question }}</p>
        </div>
        <template v-if="turn.answer">
            <p class="message-label">
                {{ turn.answer.status === 'answered' ? '报告回答' : '未获得可核验回答' }}
            </p>
            <p v-if="!turn.answer.statements.length">{{ questionReasons[turn.answer.reason] }}</p>
            <ol v-else>
                <li v-for="(statement, index) in turn.answer.statements" :key="index">
                    <p>{{ statement.text }}</p>
                    <small v-if="statement.kind === 'inference'">基于证据的解释与归纳</small>
                    <evidence-citation
                        v-for="citation in statement.citations"
                        :key="citation.evidenceId + citation.quote"
                        :evidence="report.evidence.find((item) => item.id === citation.evidenceId)!"
                    />
                </li>
            </ol>
            <router-link v-if="turn.revisionRunId" :to="`/runs/${turn.revisionRunId}`"
                >查看本轮新版报告执行</router-link
            >
            <router-link v-if="turn.followupRunId" :to="`/runs/${turn.followupRunId}`"
                >查看本轮补充研究执行</router-link
            >
            <button type="button" @click="$emit('select', turn.id)">查看本轮用量与后续操作</button>
        </template>
        <p v-else role="status">本轮正在处理，完成后可继续发送。</p>
    </article>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { Report, ReportConversation } from '@scova/models';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
import { questionReasons } from '@/utils/report-questions';
defineProps<{ turn: ReportConversation['turns'][number]; report: Report }>();
defineEmits<{ select: [id: string] }>();
</script>

<style scoped>
.conversation-turn,
li {
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.conversation-turn {
    padding-block: 1rem;
    border-block-end: 0.0625rem solid var(--scova-border);
}
.user-message {
    padding: 1rem;
    border-radius: 0.75rem;
    background: var(--scova-selected);
}
p {
    margin: 0;
    white-space: pre-wrap;
}
.message-label,
small {
    color: var(--scova-muted);
}
ol {
    padding-inline-start: 1.25rem;
    margin: 0;
}
button,
a {
    justify-self: start;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    font: inherit;
    color: var(--scova-primary);
}
button {
    padding: 0.5rem 0.75rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
    cursor: pointer;
}
button:focus-visible,
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
