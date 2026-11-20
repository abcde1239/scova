<template>
    <section
        class="layout-grid gap-3 p-4 scova-interface"
        aria-labelledby="source-host-chart-title"
    >
        <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 id="source-host-chart-title" class="sr-only">图表数据与下载</h3>
            <action-button :busy="generation.isPending.value" @click="generate">
                {{ chart ? '重新生成图表' : '生成来源图表' }}
            </action-button>
        </div>
        <template v-if="chart">
            <p class="m-0 text-muted">
                统计整份报告中由结论和变化记录引用的去重网页来源，按网站主机名分组。
            </p>
            <p v-if="!chart.rows.length" class="m-0" role="status">没有可统计的网页引用来源。</p>
            <template v-else>
                <ul class="list-none layout-grid gap-2 p-0 m-0" aria-hidden="true">
                    <li v-for="row in chart.rows" :key="row.hostname" class="layout-grid gap-1">
                        <div class="flex justify-between gap-3 break-anywhere">
                            <span>{{ row.hostname }}</span
                            ><span>{{ row.count }}</span>
                        </div>
                        <div
                            class="rounded-2 bg-surface border-theme h-2"
                            :style="{
                                inlineSize: `${(row.count / maxCount) * 100}%`,
                                background: 'var(--scova-primary)',
                            }"
                        />
                    </li>
                </ul>
                <details class="layout-grid">
                    <summary class="source-disclosure-control min-h-11 px-2 py-2">
                        查看图表数据及引用
                    </summary>
                    <div
                        class="overflow-x-auto keyboard-focus-wide"
                        role="region"
                        aria-label="图表数据"
                        tabindex="0"
                    >
                        <table class="w-full text-sm text-left border-collapse">
                            <caption class="sr-only">
                                各主机名的去重引用来源数
                            </caption>
                            <thead>
                                <tr>
                                    <th scope="col" class="p-2">网站主机名</th>
                                    <th scope="col" class="p-2">来源数</th>
                                    <th scope="col" class="p-2">引用来源</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="row in chart.rows"
                                    :key="row.hostname"
                                    class="[border-top:0.0625rem_solid_var(--scova-border)]"
                                >
                                    <th scope="row" class="p-2 break-anywhere">
                                        {{ row.hostname }}
                                    </th>
                                    <td class="p-2">{{ row.count }}</td>
                                    <td class="p-2 min-w-[9rem]">
                                        <ul class="list-none layout-grid gap-1 p-0 m-0">
                                            <li
                                                v-for="source in row.sources"
                                                :key="source.sourceId"
                                            >
                                                <a
                                                    v-if="linkFor(source.evidenceIds)"
                                                    class="reference-link break-anywhere"
                                                    :href="linkFor(source.evidenceIds)"
                                                    >{{ sourceLabel(source.evidenceIds) }}</a
                                                >
                                                <span v-else class="break-anywhere">{{
                                                    sourceLabel(source.evidenceIds)
                                                }}</span>
                                            </li>
                                        </ul>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </details>
            </template>
            <div class="flex flex-wrap items-center gap-3">
                <action-button v-if="!expired" :busy="!!pendingDownload" @click="downloadChart"
                    >下载 SVG 图表</action-button
                >
                <span v-else class="text-muted">下载已过期，请重新生成图表。</span>
            </div>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { Report, ReportSourceHostChart } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import { downloadReportChartEndpoint, generateReportChartEndpoint } from '@/api/report-charts';
import { toApiError } from '@/api/errors';
import { usePrivateDownload } from '@/composable/usePrivateDownload';
import { useActionNotification } from '@/composable/useActionNotification';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';

const props = defineProps<{ report: Report; visibleEvidenceIds: string[] }>();
const lifecycle = useSessionLifecycle();
const notice = useActionNotification();
const generation = useSessionMutation(generateReportChartEndpoint, lifecycle);
const chart = shallowRef<ReportSourceHostChart>();
const expired = ref(false);
const maxCount = computed(() => Math.max(1, ...(chart.value?.rows.map((row) => row.count) ?? [])));
const evidence = computed(() => new Map(props.report.evidence.map((entry) => [entry.id, entry])));
const linked = computed(() => new Set(props.visibleEvidenceIds));
const { download, pending: pendingDownload } = usePrivateDownload();
function downloadChart() {
    if (!chart.value || expired.value) return;
    const reportId = props.report.id;
    const chartId = chart.value.id;
    return download(
        downloadReportChartEndpoint,
        { reportId, chartId },
        chartId,
        `scova-source-hosts-${reportId}.svg`,
    );
}
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const stopExpiry = () => clearTimeout(expiryTimer);
onUnmounted(stopExpiry);
watch([() => props.report.id, () => lifecycle.session.epoch], () => {
    stopExpiry();
    chart.value = undefined;
    expired.value = false;
});

const linkFor = (ids: string[]) => {
    const first = ids.find((id) => linked.value.has(id));
    return first ? `#evidence-${first}` : undefined;
};
function sourceLabel(ids: string[]) {
    for (const id of ids) {
        const entry = evidence.value.get(id);
        if (entry) return entry.title || entry.url;
    }
    return '保存的引用';
}

async function generate() {
    if (generation.isPending.value) return;
    const scope = lifecycle.capture();
    const reportId = props.report.id;
    try {
        const { data } = await generation.mutateAsync({ input: { params: { reportId } } });
        if (!scope.isCurrent() || reportId !== props.report.id) return;
        if (
            data.reportId !== reportId ||
            Date.parse(data.reportVersion) !== Date.parse(props.report.publishedAt)
        )
            throw new Error('图表与当前报告版本不匹配');
        chart.value = data;
        stopExpiry();
        const delay = Date.parse(data.expiresAt) - Date.now();
        expired.value = delay <= 0;
        if (!expired.value)
            expiryTimer = setTimeout(() => {
                expired.value = true;
            }, delay);
        notice.success('已生成来源图表');
    } catch (error) {
        if (scope.isCurrent() && reportId === props.report.id)
            notice.error('无法生成来源图表', toApiError(error).message);
    }
}
</script>
