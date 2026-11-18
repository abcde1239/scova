<template>
    <section v-if="screening" class="layout-grid gap-3 scova-interface" aria-label="采集日期筛选">
        <p class="m-0">
            窗口 {{ date(screening.window.start) }} 至 {{ date(screening.window.end) }} · 收录
            {{ screening.accepted }} 页 · 日期未确认 {{ screening.unconfirmed }} 页 · 窗口外剔除
            {{ screening.outside }} 页
        </p>
        <details v-if="unknown.length">
            <summary class="source-disclosure-control min-h-11 py-2 px-2">
                日期未确认的来源 · 不计入采集结果
            </summary>
            <ul class="layout-grid gap-2 pl-5 m-0">
                <li v-for="entry in unknown" :key="entry.pageId">
                    <a
                        v-if="sourceLink(entry.url)"
                        class="external-link"
                        :href="sourceLink(entry.url)"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ entry.title ?? entry.url }}<app-icon name="source" /><span
                            class="text-muted"
                            >新窗口</span
                        ></a
                    >
                    <span v-else>{{ entry.title ?? '来源地址不可用' }}</span>
                    <span class="text-muted">
                        · {{ entry.dateValue ?? entry.publishedAt ?? '日期未确认' }} ·
                        {{ dateSourceLabel(entry.dateSource) }}</span
                    >
                </li>
            </ul>
        </details>
    </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { Coverage } from '@scova/models';
import AppIcon from '@/components/common/AppIcon.vue';
import { sourceLink } from '@/composables/useReport';
import { dateSourceLabel } from '@/utils/source-dates';
const props = defineProps<{ coverage: Coverage }>();
const screening = computed(() => props.coverage.dateScreening);
const unknown = computed(() =>
    screening.value?.unconfirmedHandling === 'discard'
        ? []
        : (screening.value?.entries.filter((entry) => entry.status === 'unconfirmed') ?? []),
);
const date = (value: string) => new Date(value).toLocaleDateString('zh-CN');
</script>
