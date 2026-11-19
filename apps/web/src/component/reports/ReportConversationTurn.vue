<template>
    <article
        :id="`turn-${turn.id}`"
        class="conversation-turn"
        tabindex="-1"
        :aria-label="turn.round ? `第 ${turn.round} 轮对话` : '报告对话'"
    >
        <div class="user-message">
            <span class="message-label">{{ turn.round ? `第 ${turn.round} 轮` : '你的问题' }}</span>
            <p>{{ turn.question }}</p>
        </div>
        <template v-if="turn.answer">
            <div class="flex items-center gap-2 text-xs text-muted">
                <img src="/favicon.ico?v=ebde566c" alt="" class="w-5 h-5 object-contain" /><span
                    lang="en"
                    >Scova</span
                >
            </div>
            <div class="assistant-message">
                <p v-if="!turn.answer.statements.length">
                    {{ questionReasons[turn.answer.reason] }}
                </p>
                <div
                    v-for="(statement, index) in turn.answer.statements"
                    :key="index"
                    class="answer-paragraph"
                >
                    <p :class="{ 'font-medium': index === 0 }">{{ statement.text }}</p>
                    <small v-if="statement.kind === 'inference'" class="text-muted"
                        >基于证据的解释与归纳</small
                    >
                </div>
                <p
                    v-if="turn.answer.needsResearch && turn.answer.statements.length"
                    class="text-muted text-sm"
                >
                    这部分仍需补充资料。
                </p>
            </div>
            <div v-if="sources.length" class="answer-sources" aria-label="本轮来源">
                <details v-for="source in sources" :key="source.url" class="source-group">
                    <summary>
                        <span class="source-letter" aria-hidden="true">{{
                            source.host.charAt(0).toUpperCase()
                        }}</span
                        >{{ source.title }}
                    </summary>
                    <div class="source-quotes">
                        <a
                            v-if="source.link"
                            class="external-link"
                            :href="source.link"
                            target="_blank"
                            rel="noopener noreferrer"
                            >{{ source.host }}<app-icon name="source"
                        /></a>
                        <div v-for="citation in source.citations" :key="citation.quote">
                            <blockquote>{{ citation.quote }}</blockquote>
                            <small class="text-muted"
                                >用于回答第 {{ citation.statements.join('、') }} 段</small
                            >
                        </div>
                        <details>
                            <summary>保存片段与定位</summary>
                            <evidence-citation
                                v-for="evidence in source.evidence"
                                :key="evidence.id"
                                :evidence="evidence"
                                :embedded="true"
                                :hide-source-link="true"
                            />
                        </details>
                    </div>
                </details>
            </div>
            <details class="usage-details">
                <summary>本轮用量</summary>
                <dl>
                    <div>
                        <dt>模型尝试</dt>
                        <dd>{{ turn.answer.usage.attempts }} 次</dd>
                    </div>
                    <div>
                        <dt>输入 token</dt>
                        <dd>{{ turn.answer.usage.inputTokens }}</dd>
                    </div>
                    <div>
                        <dt>输出 token</dt>
                        <dd>{{ turn.answer.usage.outputTokens }}</dd>
                    </div>
                </dl>
                <p>
                    {{
                        turn.answer.usage.estimated
                            ? '含保守估算，不代表精确扣款。'
                            : '本轮已记录的问答用量。'
                    }}问答用量单独计量。
                </p>
            </details>
        </template>
        <p v-else-if="!question" role="status">正在根据报告资料回答…</p>
        <div v-if="question" class="turn-actions">
            <followup-action
                v-for="operation in turn.answer ? operations : (['research'] as const)"
                :key="operation"
                :report-id="turn.reportId"
                :question-id="turn.id"
                :report="report"
                :question="question"
                :disabled="composerOpen"
                :operation="operation"
                :round="turn.round"
                :latest-run-id="
                    continuations?.find(
                        (run) => run.questionId === turn.id && run.operation === operation,
                    )?.runId
                "
                @protected-change="updateProtection(operation, $event)"
                @active-change="updateActive(operation, $event)"
                @artifact="emit('artifact', $event)"
                @open-artifact="emit('openArtifact', $event)"
                @merge="emit('merge', $event)"
            />
        </div>
    </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report, ReportConversation } from '@scova/models';
import AppIcon from '@/component/common/AppIcon.vue';
import EvidenceCitation from '@/component/reports/EvidenceCitation.vue';
import FollowupAction from '@/component/reports/FollowupAction.vue';
import { questionReasons } from '@/utils/report/questions';
import { conversationSources } from '@/utils/report/conversation';
const props = defineProps<{
    turn: ReportConversation['turns'][number];
    report?: Report;
    composerOpen?: boolean;
    continuations?: ReportConversation['continuations'];
}>();
type Artifact = NonNullable<ReportConversation['artifacts']>[number];
const emit = defineEmits<{
    protectedChange: [value: boolean];
    activeChange: [value: boolean];
    artifact: [artifact: Artifact];
    openArtifact: [artifact: Artifact];
    merge: [reportId: string];
}>();
const operations = ['research', 'revise'] as const;
const question = computed(() => {
    const { turn } = props;
    if (turn.answer) return { ...turn, answer: turn.answer };
    if (turn.searchSelection && turn.followupRunId)
        return {
            ...turn,
            answer: null,
            followupRunId: turn.followupRunId,
            searchSelection: turn.searchSelection,
        };
});
const sources = computed(() =>
    props.report ? conversationSources(props.turn.answer, props.report) : [],
);
const protection = new Map<string, boolean>();
const active = new Map<string, boolean>();
function updateProtection(operation: string, value: boolean) {
    protection.set(operation, value);
    emit('protectedChange', [...protection.values()].some(Boolean));
}
function updateActive(operation: string, value: boolean) {
    active.set(operation, value);
    emit('activeChange', [...active.values()].some(Boolean));
}
</script>

<style scoped>
.conversation-turn {
    @apply grid gap-4 min-w-0 break-anywhere py-5 [scroll-margin-block-start:2rem] keyboard-focus-wide;
}
.user-message {
    @apply grid gap-1 justify-self-end max-w-[94%] rounded-3 [background:var(--scova-selected)] px-4 py-3;
}
.message-label {
    @apply text-xs text-muted;
}
.assistant-message {
    @apply grid gap-4 text-[1.0625rem] leading-[1.85];
}
.answer-paragraph {
    @apply grid gap-1;
}
.conversation-turn p {
    @apply whitespace-pre-wrap m-0;
}
.answer-sources {
    @apply flex flex-wrap gap-2 items-start;
}
.source-group {
    @apply max-w-full min-w-0 border-theme rounded-3 text-sm;
}
.source-group[open] {
    @apply w-full;
}
summary {
    @apply min-h-11 cursor-pointer keyboard-focus-wide;
}
.source-group > summary {
    @apply flex items-center gap-2 px-3 py-2;
}
.source-letter {
    @apply flex items-center justify-center w-5 h-5 rounded-full [background:var(--scova-selected)] text-primary text-xs flex-none;
}
.source-quotes {
    @apply grid gap-3 px-3 pb-3 [@media(max-width:_40rem)]:px-1.5;
}
.source-quotes blockquote {
    @apply whitespace-pre-wrap m-0 [border-left:0.125rem_solid_var(--scova-primary)] pl-3;
}
.usage-details {
    @apply text-sm text-muted;
}
.usage-details > summary {
    @apply inline-flex items-center;
}
.usage-details dl {
    @apply flex flex-wrap gap-4 m-0;
}
.usage-details dd {
    @apply m-0;
}
.turn-actions {
    @apply flex flex-wrap gap-2;
}
.turn-actions :deep(.followup:has(.plan-card, .run-card, .recovery-card)) {
    @apply w-full;
}
</style>
