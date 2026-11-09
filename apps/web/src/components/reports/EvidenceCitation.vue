<template>
    <details class="evidence scova-citation-tools">
        <summary>{{ evidence.title }} · 查看原文引用</summary>
        <div class="evidence-body">
            <blockquote>{{ evidence.quote }}</blockquote>
            <p v-if="evidence.snapshot?.truncated" class="scova-warning">
                采集正文曾截断，引用仅代表已保存片段。
            </p>
            <a v-if="link" :href="link" target="_blank" rel="noopener noreferrer"
                >打开原始来源（新窗口）</a
            >
            <p v-else>原始来源链接不可用。</p>
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
                    <dd>
                        {{
                            sourceDate(
                                evidence.snapshot.sourceDates?.published,
                                evidence.snapshot.publishedAt,
                            )
                        }}
                    </dd>
                </div>
                <div
                    v-if="
                        evidence.snapshot?.sourceDates &&
                        evidence.snapshot.sourceDates.modified.status !== 'unknown'
                    "
                >
                    <dt>来源更新时间</dt>
                    <dd>{{ sourceDate(evidence.snapshot.sourceDates.modified) }}</dd>
                </div>
            </dl>
            <p class="citation-history">
                这里展示已保存的引用；来源网页的当前内容可能变化，完整采集正文过期后引用仍保留。
            </p>
        </div>
    </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Evidence } from '@scova/models';
import { sourceLink } from '@/composables/useReport';
const props = defineProps<{ evidence: Evidence }>();
const link = computed(() => sourceLink(props.evidence.snapshot?.originalUrl ?? props.evidence.url));
function sourceDate(
    date: NonNullable<NonNullable<Evidence['snapshot']>['sourceDates']>['published'] | undefined,
    fallback?: string | null,
) {
    if (!date) return fallback ?? '未确认';
    if (date.status === 'conflict') return '来源声明存在冲突';
    if (date.status === 'unknown') return '未确认';
    return `${date.value}${date.precision === 'day' ? '（仅日期，时区未声明）' : date.precision === 'local' ? '（时区未声明）' : ''}`;
}
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
    gap: 0.625rem;
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
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
    font-size: 0.875rem;
}
.citation-history,
dt {
    color: var(--scova-muted);
}
.citation-history {
    font-size: 0.875rem;
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
