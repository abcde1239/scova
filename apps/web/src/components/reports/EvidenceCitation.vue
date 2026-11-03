<template>
    <details class="evidence scova-citation-tools">
        <summary>{{ evidence.title }} · 查看原文引用</summary>
        <div class="evidence-body">
            <blockquote>{{ evidence.quote }}</blockquote>
            <dl>
                <div>
                    <dt>原文定位</dt>
                    <dd>{{ evidence.location }}</dd>
                </div>
                <div v-if="evidence.snapshot">
                    <dt>字符范围</dt>
                    <dd>
                        {{ evidence.snapshot.selector.start }}–{{
                            evidence.snapshot.selector.end
                        }}（起点包含，终点不含）
                    </dd>
                </div>
                <div>
                    <dt>查阅时间</dt>
                    <dd>
                        <time :datetime="evidence.observedAt">{{ evidence.observedAt }}</time>
                    </dd>
                </div>
                <div v-if="evidence.snapshot">
                    <dt>来源发布时间</dt>
                    <dd>{{ evidence.snapshot.publishedAt ?? '未确认' }}</dd>
                </div>
            </dl>
            <p v-if="evidence.snapshot?.truncated">采集正文曾截断，引用仅代表已保存片段。</p>
            <p>这里展示已保存的引用；来源网页的当前内容可能变化，完整采集正文过期后引用仍保留。</p>
            <a v-if="link" :href="link" target="_blank" rel="noopener noreferrer"
                >打开原始来源（新窗口）</a
            >
            <p v-else>原始来源链接不可用。</p>
        </div>
    </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Evidence } from '@scova/models';
import { sourceLink } from '@/composables/useReport';
const props = defineProps<{ evidence: Evidence }>();
const link = computed(() => sourceLink(props.evidence.snapshot?.originalUrl ?? props.evidence.url));
</script>

<style scoped>
.evidence {
    min-inline-size: 0;
    border-block-end: 0.0625rem solid color-mix(in srgb, var(--scova-border) 30%, transparent);
    overflow-wrap: anywhere;
}
summary {
    min-block-size: 2.75rem;
    padding: 0.5rem 0;
    cursor: pointer;
    font-weight: 500;
}
.evidence-body {
    display: grid;
    gap: 1rem;
    padding-block-end: 0.75rem;
}
blockquote {
    margin: 0;
    padding: 0.75rem 1rem;
    border-inline-start: 0.1875rem solid var(--scova-primary);
    background: var(--scova-selected);
    white-space: pre-wrap;
}
dl {
    display: grid;
    gap: 0.75rem;
    margin: 0;
}
dt {
    font-weight: 500;
}
dd {
    margin: 0;
}
p {
    margin: 0;
}
a {
    justify-self: start;
    min-block-size: 2.75rem;
    display: inline-flex;
    align-items: center;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
    cursor: pointer;
}
summary:focus-visible,
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
