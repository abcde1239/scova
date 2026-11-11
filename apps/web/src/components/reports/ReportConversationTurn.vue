<template>
    <article
        class="conversation-turn layout-grid gap-3 break-anywhere pt-4 pb-4 [border-bottom:0.0625rem_solid_var(--scova-border)]"
    >
        <div class="user-message rounded-3 [background:var(--scova-selected)] p-4">
            <p class="message-label whitespace-pre-wrap text-muted m-0">你的问题</p>
            <p class="whitespace-pre-wrap m-0">{{ turn.question }}</p>
        </div>
        <template v-if="turn.answer">
            <p class="message-label whitespace-pre-wrap text-muted m-0">
                {{ turn.answer.status === 'answered' ? '报告回答' : '未获得可核验回答' }}
            </p>
            <p class="whitespace-pre-wrap m-0" v-if="!turn.answer.statements.length">
                {{ questionReasons[turn.answer.reason] }}
            </p>
            <ol class="pl-5 m-0" v-else>
                <li
                    class="layout-grid gap-3 break-anywhere"
                    v-for="(statement, index) in turn.answer.statements"
                    :key="index"
                >
                    <p class="whitespace-pre-wrap m-0">{{ statement.text }}</p>
                    <small class="text-muted" v-if="statement.kind === 'inference'"
                        >基于证据的解释与归纳</small
                    >
                    <evidence-citation
                        v-for="citation in statement.citations"
                        :key="citation.evidenceId + citation.quote"
                        :evidence="report.evidence.find((item) => item.id === citation.evidenceId)!"
                    />
                </li>
            </ol>
            <router-link
                class="justify-self-start min-h-11 max-w-full font-inherit text-primary keyboard-focus-wide"
                v-if="turn.revisionRunId"
                :to="`/runs/${turn.revisionRunId}`"
                >查看本轮新版报告执行</router-link
            >
            <router-link
                class="justify-self-start min-h-11 max-w-full font-inherit text-primary keyboard-focus-wide"
                v-if="turn.followupRunId"
                :to="`/runs/${turn.followupRunId}`"
                >查看本轮补充研究执行</router-link
            >
            <button
                class="justify-self-start min-h-11 max-w-full font-inherit text-primary border-theme rounded-2 bg-surface cursor-pointer py-2 px-3 keyboard-focus-wide"
                type="button"
                @click="$emit('select', turn.id)"
            >
                查看本轮用量与后续操作
            </button>
        </template>
        <p class="whitespace-pre-wrap m-0" v-else role="status">本轮正在处理，完成后可继续发送。</p>
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
