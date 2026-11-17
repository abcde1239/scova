<template>
    <app-theme-provider>
        <div class="min-h-screen bg-surface text-default">
            <header
                class="showcase-toolbar scova-interface layout-grid gap-4 border-b border-subtle mx-auto max-w-[68.75rem] px-5 py-6"
            >
                <h1 class="text-[1.25rem] m-0">四类报告交付预览</h1>
                <p class="text-muted m-0">
                    同一组虚构资料，展示四类已保存成果。可切换形式、明暗主题并打开来源核对。
                </p>
                <div class="flex flex-wrap gap-4">
                    <label class="layout-grid gap-2 min-w-0"
                        >产出形式
                        <select
                            v-model="format"
                            class="min-h-11 bg-surface text-default border-theme rounded-2 px-3 font-inherit"
                        >
                            <option value="brief">简报</option>
                            <option value="list">主题清单</option>
                            <option value="comparison">对比</option>
                            <option value="research_report">研究报告</option>
                        </select>
                    </label>
                    <label class="layout-grid gap-2 min-w-0"
                        >内容长度
                        <select
                            v-model="length"
                            class="min-h-11 bg-surface text-default border-theme rounded-2 px-3 font-inherit"
                        >
                            <option value="standard">常规</option>
                            <option value="long">长文与长链接</option>
                        </select>
                    </label>
                    <label class="layout-grid gap-2 min-w-0"
                        >文字缩放
                        <select
                            v-model="scale"
                            class="min-h-11 bg-surface text-default border-theme rounded-2 px-3 font-inherit"
                        >
                            <option value="100">100%</option>
                            <option value="200">200%</option>
                        </select>
                    </label>
                    <label class="layout-grid gap-2 min-w-0"
                        >显示主题
                        <select
                            :value="appearance.mode"
                            @change="
                                appearance.setMode(
                                    ($event.target as HTMLSelectElement).value as 'light' | 'dark',
                                )
                            "
                            class="min-h-11 bg-surface text-default border-theme rounded-2 px-3 font-inherit"
                        >
                            <option value="light">浅色</option>
                            <option value="dark">深色</option>
                        </select>
                    </label>
                </div>
            </header>
            <main
                class="showcase-report mx-auto px-5 py-10 sm:px-10"
                :class="
                    format === 'comparison' || format === 'list'
                        ? 'max-w-[100rem]'
                        : 'max-w-[68.75rem]'
                "
            >
                <component :is="components[format]" :report="report" :show-changes="false" />
            </main>
        </div>
    </app-theme-provider>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import type { Report } from '@scova/models';
import AppThemeProvider from '@/theme/AppThemeProvider.vue';
import ReportBrief from '@/components/reports/ReportBrief.vue';
import TopicListReport from '@/components/reports/TopicListReport.vue';
import ComparisonReport from '@/components/reports/ComparisonReport.vue';
import ResearchReport from '@/components/reports/ResearchReport.vue';
import { useAppearanceStore } from '@/store/appearance';
import { artifactReport } from '@/utils/report-artifacts';
import { reportFormatSample, reportLongFormatSample } from './report-format-sample';
const appearance = useAppearanceStore();
const format = ref<Report['format']>('brief');
const length = ref('standard');
const scale = ref('100');
const previousFontSize = document.documentElement.style.fontSize;
watch(scale, (value) => {
    document.documentElement.style.fontSize = `${value}%`;
});
onBeforeUnmount(() => {
    document.documentElement.style.fontSize = previousFontSize;
});
const report = computed(() =>
    artifactReport(
        length.value === 'long'
            ? reportLongFormatSample(format.value)
            : reportFormatSample(format.value),
        format.value,
    ),
);
const components = {
    brief: ReportBrief,
    list: TopicListReport,
    comparison: ComparisonReport,
    research_report: ResearchReport,
};
</script>
