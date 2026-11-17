<template>
    <component
        :is="embedded ? 'div' : 'details'"
        class="evidence scova-citation-tools [&&]:(min-w-0 [border-bottom:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)] break-anywhere) [&.evidence--embedded]:[border:0]"
        :class="{ 'evidence--embedded': embedded }"
    >
        <summary
            class="source-disclosure-control [.citation-metadata_&:is(summary)]:(min-h-11 font-normal) min-h-11 font-medium py-2 px-2"
            v-if="!embedded"
        >
            {{ evidence.title }} · 查看原文引用
        </summary>
        <div class="evidence-body grid gap-2.5 pb-3 [.evidence--embedded_&.evidence-body]:p-0">
            <blockquote
                class="[border-left:0.1875rem_solid_var(--scova-primary)] [background:var(--scova-selected)] whitespace-pre-wrap m-0 py-3 px-4 [@media(max-width:_40rem)]:(pl-1.5 pr-1.5)"
            >
                {{ evidence.quote }}
            </blockquote>
            <p v-if="evidence.snapshot?.truncated" class="scova-warning m-0">
                采集正文曾截断，引用仅代表已保存片段。
            </p>
            <a
                class="external-link source-inline-action cursor-pointer keyboard-focus-wide"
                v-if="!hideSourceLink && link"
                :href="link"
                target="_blank"
                rel="noopener noreferrer"
            >
                打开原始来源（新窗口）<app-icon name="source" />
            </a>
            <p class="m-0" v-else-if="!hideSourceLink">原始来源链接不可用。</p>
            <details class="citation-metadata text-muted text-[0.8125rem]">
                <summary
                    class="source-disclosure-control [.citation-metadata_&:is(summary)]:(min-h-11 font-normal) min-h-11 font-medium py-2 px-2"
                >
                    采集与定位信息
                </summary>
                <dl
                    class="grid gap-3 grid-cols-[repeat(auto-fit,_minmax(min(100%,_14rem),_1fr))] text-[0.875rem] m-0"
                >
                    <div>
                        <dt class="text-muted font-medium">原文定位</dt>
                        <dd class="m-0">{{ evidence.location }}</dd>
                    </div>
                    <div v-if="evidence.snapshot">
                        <dt class="text-muted font-medium">字符范围</dt>
                        <dd class="m-0">
                            {{ evidence.snapshot.selector.start }}–{{
                                evidence.snapshot.selector.end
                            }}（起点包含，终点不含）
                        </dd>
                    </div>
                    <div>
                        <dt class="text-muted font-medium">查阅时间</dt>
                        <dd class="m-0">
                            <time :datetime="evidence.observedAt">{{ evidence.observedAt }}</time>
                        </dd>
                    </div>
                    <div v-if="evidence.snapshot">
                        <dt class="text-muted font-medium">来源发布时间</dt>
                        <dd class="m-0">
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
                        <dt class="text-muted font-medium">来源更新时间</dt>
                        <dd class="m-0">
                            {{ sourceDate(evidence.snapshot.sourceDates.modified) }}
                        </dd>
                    </div>
                </dl>
            </details>
            <p
                v-if="!embedded"
                class="citation-history leading-[1.7] text-muted text-[0.875rem] m-0"
            >
                这里展示已保存的引用；来源网页的当前内容可能变化，完整采集正文过期后引用仍保留。
            </p>
        </div>
    </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Evidence } from '@scova/models';
import { sourceLink } from '@/composables/useReport';
import AppIcon from '@/components/common/AppIcon.vue';
const props = defineProps<{ evidence: Evidence; embedded?: boolean; hideSourceLink?: boolean }>();
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
