<template>
    <section v-if="sections.length" class="findings" aria-labelledby="findings-title">
        <h3 id="findings-title">信息与来源对照</h3>
        <p class="scova-interface">按信息项查阅内容与依据；表格可在自身区域左右滚动。</p>
        <div class="findings-scroll" role="region" aria-labelledby="findings-title" tabindex="0">
            <table class="findings-table">
                <caption>
                    已收集信息对照
                </caption>
                <thead>
                    <tr>
                        <th scope="col">序号</th>
                        <th scope="col">信息与引用</th>
                        <th scope="col">资料类型</th>
                    </tr>
                </thead>
                <tbody v-for="section in sections" :key="section.kind">
                    <tr class="findings-group">
                        <th colspan="3" scope="rowgroup">
                            <h3 :id="`claims-${section.kind}`" class="scova-content-title">
                                {{ section.title }}
                            </h3>
                        </th>
                    </tr>
                    <tr
                        v-for="(claim, index) in section.claims"
                        :key="claim.id"
                        class="finding-row"
                    >
                        <th scope="row" class="scova-interface">
                            {{ String(index + 1).padStart(2, '0') }}
                        </th>
                        <td><report-claim :report="report" :claim="claim" /></td>
                        <td class="scova-interface">{{ section.title }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import ReportClaim from '@/components/reports/ReportClaim.vue';
import { reportSections } from '@/composables/useReport';
const props = defineProps<{ report: Report }>();
const sections = computed(() => reportSections(props.report));
</script>

<style scoped>
.findings {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
h3,
p {
    margin: 0;
}
h3 {
    font-size: 1.25rem;
}
.findings-scroll {
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
}
.findings-scroll:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.findings-table {
    inline-size: 100%;
    min-inline-size: 35rem;
    table-layout: fixed;
    border-collapse: collapse;
}
caption {
    text-align: start;
    padding-block-end: 0.75rem;
    font-family: var(--scova-font-interface);
}
th,
td {
    text-align: start;
    vertical-align: top;
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    overflow-wrap: anywhere;
}
thead th,
.findings-group th {
    background: var(--scova-selected);
    font-family: var(--scova-font-interface);
}
thead th:first-child {
    inline-size: 4rem;
}
thead th:last-child {
    inline-size: 8rem;
}
.findings-group h3 {
    font-size: 1rem;
}
</style>
