<template>
    <article class="snapshot-detail" aria-labelledby="snapshot-title">
        <h2 id="snapshot-title" class="scova-content-title" tabindex="-1">
            {{ detail.snapshot.title }}
        </h2>
        <p class="scova-interface">这是保存的快照；原始网页的当前内容可能已经变化。</p>
        <dl class="scova-interface snapshot-metadata">
            <div>
                <dt>最近成功观测时间</dt>
                <dd>
                    <time :datetime="detail.snapshot.observedAt">{{
                        detail.snapshot.observedAt
                    }}</time>
                </dd>
            </div>
            <div>
                <dt>来源发布时间</dt>
                <dd>{{ detail.snapshot.publishedAt ?? '未确认' }}</dd>
            </div>
            <div>
                <dt>观测模式</dt>
                <dd>{{ detail.snapshot.mode === 'demo' ? '演示' : '真实' }}</dd>
            </div>
        </dl>
        <p v-if="detail.snapshot.truncated" class="scova-warning">
            本次观测正文曾被截断，快照不代表完整网页。
        </p>
        <p v-if="body === null" class="scova-warning" role="status">
            保存正文已过期、已清理或已达到已知保留期限，当前不可展示。以下保存片段和定位仍保留；不会重新抓取网页。
        </p>
        <details v-else class="snapshot-body-section">
            <summary class="scova-interface">查看保留期内正文</summary>
            <p v-if="detail.snapshot.textExpiresAt" class="scova-interface">
                正文保留至
                <time :datetime="detail.snapshot.textExpiresAt">{{
                    detail.snapshot.textExpiresAt
                }}</time
                >；页面会在已知期限撤下正文。
            </p>
            <div class="snapshot-body scova-reading">{{ body }}</div>
        </details>
        <details class="snapshot-identity scova-interface">
            <summary>查看快照身份与采集信息</summary>
            <dl>
                <div>
                    <dt>快照 ID</dt>
                    <dd>{{ detail.snapshot.id }}</dd>
                </div>
                <div>
                    <dt>来源 ID</dt>
                    <dd>{{ detail.snapshot.sourceId }}</dd>
                </div>
                <div>
                    <dt>最近成功观测 ID</dt>
                    <dd>{{ detail.snapshot.observationId }}</dd>
                </div>
                <div>
                    <dt>保存正文 SHA-256</dt>
                    <dd>{{ detail.snapshot.contentHash }}</dd>
                </div>
                <div>
                    <dt>提取版本</dt>
                    <dd>{{ detail.snapshot.extractorVersion }}</dd>
                </div>
                <div>
                    <dt>保留期限</dt>
                    <dd>{{ detail.snapshot.textExpiresAt ?? '未设置时间期限' }}</dd>
                </div>
                <div>
                    <dt>来源规范地址</dt>
                    <dd>{{ detail.snapshot.canonicalUrl }}</dd>
                </div>
                <div>
                    <dt>本次请求地址</dt>
                    <dd>{{ detail.snapshot.originalUrl }}</dd>
                </div>
                <div>
                    <dt>本次到达地址</dt>
                    <dd>{{ detail.snapshot.fetchedUrl }}</dd>
                </div>
            </dl>
        </details>
        <nav class="snapshot-actions scova-interface" aria-label="快照关联入口">
            <router-link :to="`/runs/${detail.snapshot.runId}`">查看该次执行</router-link>
            <a
                v-if="sourceLink(detail.snapshot.originalUrl)"
                :href="sourceLink(detail.snapshot.originalUrl)"
                target="_blank"
                rel="noopener noreferrer"
                >打开原始来源（新窗口）</a
            >
        </nav>
        <section class="saved-quotes scova-citation-tools" aria-labelledby="saved-quotes-title">
            <h3 id="saved-quotes-title">保存片段</h3>
            <p>每条片段保留各自的执行与字符定位，可在执行页查找已交付报告。</p>
            <p v-if="detail.quotesTruncated" role="status">
                本次最多返回 100 条保存片段，还有更多片段未返回；当前没有片段分页接口。
            </p>
            <p v-if="!detail.quotes.length">这份快照没有返回保存片段。</p>
            <details v-for="(quote, index) in detail.quotes" :key="quote.id" class="saved-quote">
                <summary>保存片段 {{ index + 1 }}</summary>
                <blockquote>{{ quote.quote }}</blockquote>
                <dl>
                    <div>
                        <dt>证据 ID</dt>
                        <dd>{{ quote.id }}</dd>
                    </div>
                    <div>
                        <dt>片段 SHA-256</dt>
                        <dd>{{ quote.quoteHash }}</dd>
                    </div>
                    <div>
                        <dt>字符定位</dt>
                        <dd>
                            {{ quote.selector.start }}–{{
                                quote.selector.end
                            }}（起点包含，终点不含）
                        </dd>
                    </div>
                    <div>
                        <dt>提取版本</dt>
                        <dd>{{ quote.selector.extractorVersion }}</dd>
                    </div>
                </dl>
                <router-link :to="`/runs/${quote.runId}`">查看片段对应执行</router-link>
            </details>
        </section>
    </article>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { SnapshotDetail } from '@/api/source-history';
import { sourceLink } from '@/composables/useReport';
defineProps<{ detail: SnapshotDetail; body: string | null }>();
</script>

<style scoped>
.snapshot-detail,
.saved-quotes {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.snapshot-detail {
    inline-size: min(100%, 45rem);
}
h2,
h3,
p,
dl {
    margin: 0;
}
h2 {
    font-size: 1.5rem;
}
h3 {
    font-size: 1.125rem;
    font-weight: 600;
}
dl {
    display: grid;
    gap: 1rem;
}
.snapshot-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
}
dt {
    font-weight: 500;
}
dd {
    margin: 0;
}
summary {
    cursor: pointer;
    min-block-size: 2.75rem;
    padding-block: 0.5rem;
    box-sizing: border-box;
}
details > :not(summary) {
    margin-block-start: 1rem;
}
.snapshot-body,
blockquote {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    cursor: default;
}
blockquote {
    margin: 1rem 0 0;
    padding: 0.75rem;
    border-inline-start: 0.1875rem solid var(--scova-primary);
    background: var(--scova-selected);
}
.saved-quote {
    border-block-start: 0.0625rem solid var(--scova-border);
}
.snapshot-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
}
a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
a:focus-visible,
summary:focus-visible,
h2:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
