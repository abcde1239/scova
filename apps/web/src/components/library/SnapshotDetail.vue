<template>
    <article
        class="snapshot-detail layout-grid gap-6 break-anywhere w-[min(100%,_45rem)]"
        aria-labelledby="snapshot-title"
    >
        <h2
            id="snapshot-title"
            class="scova-content-title text-[1.5rem] m-0 keyboard-focus-wide"
            tabindex="-1"
        >
            {{ detail.snapshot.title }}
        </h2>
        <p class="scova-interface m-0">这是保存的快照；原始网页的当前内容可能已经变化。</p>
        <dl class="scova-interface snapshot-metadata flex gap-[1rem_2rem] flex-wrap m-0">
            <div>
                <dt class="font-medium">最近成功观测时间</dt>
                <dd class="m-0">
                    <time :datetime="detail.snapshot.observedAt">{{
                        detail.snapshot.observedAt
                    }}</time>
                </dd>
            </div>
            <div>
                <dt class="font-medium">来源发布时间</dt>
                <dd class="m-0">{{ detail.snapshot.publishedAt ?? '未确认' }}</dd>
            </div>
            <div>
                <dt class="font-medium">观测模式</dt>
                <dd class="m-0">{{ detail.snapshot.mode === 'demo' ? '演示' : '真实' }}</dd>
            </div>
        </dl>
        <p v-if="detail.snapshot.truncated" class="scova-warning m-0">
            本次观测正文曾被截断，快照不代表完整网页。
        </p>
        <p v-if="body === null" class="scova-warning m-0" role="status">
            保存正文已过期、已清理或已达到已知保留期限，当前不可展示。以下保存片段和定位仍保留；不会重新抓取网页。
        </p>
        <details v-else class="[&>:not(summary)]:mt-4 snapshot-body-section">
            <summary
                class="scova-interface cursor-pointer min-h-11 pt-2 pb-2 box-border keyboard-focus-wide"
            >
                查看保留期内正文
            </summary>
            <p v-if="detail.snapshot.textExpiresAt" class="scova-interface m-0">
                正文保留至
                <time :datetime="detail.snapshot.textExpiresAt">{{
                    detail.snapshot.textExpiresAt
                }}</time
                >；页面会在已知期限撤下正文。
            </p>
            <div
                class="snapshot-body scova-reading whitespace-pre-wrap break-anywhere cursor-default"
            >
                {{ body }}
            </div>
        </details>
        <details class="[&>:not(summary)]:mt-4 snapshot-identity scova-interface">
            <summary class="cursor-pointer min-h-11 pt-2 pb-2 box-border keyboard-focus-wide">
                查看快照身份与采集信息
            </summary>
            <dl class="grid gap-4 m-0">
                <div>
                    <dt class="font-medium">快照 ID</dt>
                    <dd class="m-0">{{ detail.snapshot.id }}</dd>
                </div>
                <div>
                    <dt class="font-medium">来源 ID</dt>
                    <dd class="m-0">{{ detail.snapshot.sourceId }}</dd>
                </div>
                <div>
                    <dt class="font-medium">最近成功观测 ID</dt>
                    <dd class="m-0">{{ detail.snapshot.observationId }}</dd>
                </div>
                <div>
                    <dt class="font-medium">保存正文 SHA-256</dt>
                    <dd class="m-0">{{ detail.snapshot.contentHash }}</dd>
                </div>
                <div>
                    <dt class="font-medium">提取版本</dt>
                    <dd class="m-0">{{ detail.snapshot.extractorVersion }}</dd>
                </div>
                <div>
                    <dt class="font-medium">保留期限</dt>
                    <dd class="m-0">{{ detail.snapshot.textExpiresAt ?? '未设置时间期限' }}</dd>
                </div>
                <div>
                    <dt class="font-medium">来源规范地址</dt>
                    <dd class="m-0">{{ detail.snapshot.canonicalUrl }}</dd>
                </div>
                <div>
                    <dt class="font-medium">本次请求地址</dt>
                    <dd class="m-0">{{ detail.snapshot.originalUrl }}</dd>
                </div>
                <div>
                    <dt class="font-medium">本次到达地址</dt>
                    <dd class="m-0">{{ detail.snapshot.fetchedUrl }}</dd>
                </div>
            </dl>
        </details>
        <nav
            class="snapshot-actions scova-interface flex flex-wrap gap-4"
            aria-label="快照关联入口"
        >
            <router-link class="navigation-link" :to="`/runs/${detail.snapshot.runId}`"
                >查看该次执行</router-link
            >
            <a
                class="external-link cursor-pointer keyboard-focus-wide"
                v-if="sourceLink(detail.snapshot.originalUrl)"
                :href="sourceLink(detail.snapshot.originalUrl)"
                target="_blank"
                rel="noopener noreferrer"
            >
                打开原始来源（新窗口）<app-icon name="source" />
            </a>
        </nav>
        <section
            class="saved-quotes scova-citation-tools layout-grid gap-6 break-anywhere"
            aria-labelledby="saved-quotes-title"
        >
            <h3 class="text-[1.125rem] font-semibold m-0" id="saved-quotes-title">保存片段</h3>
            <p class="m-0">每条片段保留各自的执行与字符定位，可在执行页查找已交付报告。</p>
            <p class="m-0" v-if="detail.quotesTruncated" role="status">
                本次最多返回 100 条保存片段，还有更多片段未返回；当前没有片段分页接口。
            </p>
            <p class="m-0" v-if="!detail.quotes.length">这份快照没有返回保存片段。</p>
            <details
                v-for="(quote, index) in detail.quotes"
                :key="quote.id"
                class="[&>:not(summary)]:mt-4 saved-quote [border-top:0.0625rem_solid_var(--scova-border)]"
            >
                <summary class="cursor-pointer min-h-11 pt-2 pb-2 box-border keyboard-focus-wide">
                    保存片段 {{ index + 1 }}
                </summary>
                <blockquote
                    class="whitespace-pre-wrap break-anywhere cursor-default mt-4 mb-0 [border-left:0.1875rem_solid_var(--scova-primary)] [background:var(--scova-selected)] mx-0 p-3"
                >
                    {{ quote.quote }}
                </blockquote>
                <dl class="grid gap-4 m-0">
                    <div>
                        <dt class="font-medium">证据 ID</dt>
                        <dd class="m-0">{{ quote.id }}</dd>
                    </div>
                    <div>
                        <dt class="font-medium">片段 SHA-256</dt>
                        <dd class="m-0">{{ quote.quoteHash }}</dd>
                    </div>
                    <div>
                        <dt class="font-medium">字符定位</dt>
                        <dd class="m-0">
                            {{ quote.selector.start }}–{{
                                quote.selector.end
                            }}（起点包含，终点不含）
                        </dd>
                    </div>
                    <div>
                        <dt class="font-medium">提取版本</dt>
                        <dd class="m-0">{{ quote.selector.extractorVersion }}</dd>
                    </div>
                </dl>
                <router-link class="navigation-link" :to="`/runs/${quote.runId}`"
                    >查看执行<app-icon name="chevron"
                /></router-link>
            </details>
        </section>
    </article>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { SnapshotDetail } from '@/api/source-history';
import { sourceLink } from '@/composables/useReport';
import AppIcon from '@/components/common/AppIcon.vue';
defineProps<{ detail: SnapshotDetail; body: string | null }>();
</script>
