<template>
    <section
        v-if="effects.length"
        class="feedback-effects scova-interface"
        aria-labelledby="feedback-effects-title"
    >
        <h2 id="feedback-effects-title">本报告的反馈作用</h2>
        <p>以下为本报告保存的实际作用与未执行原因；当前反馈的修改或撤销不会改写这些记录。</p>
        <ul class="effect-list">
            <li v-for="item in effects" :key="item.key" class="effect-item">
                <h3 :class="{ 'scova-partial': item.limited }">{{ item.label }}</h3>
                <p>反馈意图：{{ item.kindLabel }}</p>
                <p class="effect-text">{{ item.entry.reason }}</p>
                <details>
                    <summary>{{ item.targetLabel }}目标与执行详情</summary>
                    <dl class="effect-details">
                        <div v-if="item.targetName !== undefined">
                            <dt>{{ item.targetLabel }}内容</dt>
                            <dd class="effect-text">{{ item.targetName }}</dd>
                        </div>
                        <div>
                            <dt>{{ item.targetLabel }}标识</dt>
                            <dd>{{ item.entry.targetId }}</dd>
                        </div>
                        <div v-if="item.entry.query !== undefined">
                            <dt>本条记录的查询</dt>
                            <dd class="effect-text">{{ item.entry.query }}</dd>
                        </div>
                        <div v-if="item.entry.url !== undefined">
                            <dt>本条记录的来源网址</dt>
                            <dd>
                                <a
                                    v-if="sourceLink(item.entry.url)"
                                    :href="sourceLink(item.entry.url)"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    >{{ item.entry.url }}（在新窗口打开）</a
                                >
                                <p v-else class="effect-text">{{ item.entry.url }}</p>
                            </dd>
                        </div>
                        <div>
                            <dt>反馈标识</dt>
                            <dd>{{ item.entry.feedbackId }}</dd>
                        </div>
                    </dl>
                </details>
            </li>
        </ul>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import { sourceLink } from '@/composables/useReport';
import { reportFeedbackEffects } from '@/utils/feedback-effects';
const props = defineProps<{ report: Report }>();
const effects = computed(() => reportFeedbackEffects(props.report));
</script>

<style scoped>
.feedback-effects,
.effect-item,
.effect-details {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.feedback-effects {
    inline-size: min(100%, 45rem);
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block-start: 2rem;
}
h2,
h3,
p,
ul,
dl,
dd {
    margin: 0;
}
h2 {
    font-size: 1.25rem;
}
h3 {
    font-size: 1.125rem;
    font-weight: 600;
}
.effect-list {
    list-style: none;
    padding: 0;
    min-inline-size: 0;
}
.effect-item {
    padding-block: 1.5rem;
}
.effect-item + .effect-item {
    border-block-start: 0.0625rem solid var(--scova-border);
}
.effect-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.effect-details {
    padding-block-start: 1rem;
}
dt {
    color: var(--scova-muted);
}
summary,
a {
    min-block-size: 2.75rem;
    box-sizing: border-box;
    padding-block: 0.5rem;
    cursor: pointer;
}
summary {
    align-content: center;
}
a {
    display: block;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
}
summary:focus-visible,
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
