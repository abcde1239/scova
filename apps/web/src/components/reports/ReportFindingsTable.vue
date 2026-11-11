<template>
    <section
        v-if="sections.length"
        class="findings layout-stack break-anywhere"
        aria-labelledby="findings-title"
    >
        <h3 class="text-[1.25rem] m-0" id="findings-title">信息与来源对照</h3>
        <p class="scova-interface m-0">按信息项查阅内容与依据；表格可在自身区域左右滚动。</p>
        <div
            class="findings-scroll min-w-0 max-w-full [overflow-x:auto] [overscroll-behavior-inline:contain] keyboard-focus-wide"
            role="region"
            aria-labelledby="findings-title"
            tabindex="0"
        >
            <table
                class="findings-table w-full min-w-[35rem] [table-layout:fixed] [border-collapse:collapse]"
            >
                <caption class="text-start pb-3 [font-family:var(--scova-font-interface)]">
                    已收集信息对照
                </caption>
                <thead>
                    <tr>
                        <th
                            class="text-start [vertical-align:top] border-theme break-anywhere p-4 [thead_&:is(th)]:([background:var(--scova-selected)] [font-family:var(--scova-font-interface)]) [thead_&:is(th):first-child]:w-16 [thead_&:is(th):last-child]:w-[8rem]"
                            scope="col"
                        >
                            序号
                        </th>
                        <th
                            class="text-start [vertical-align:top] border-theme break-anywhere p-4 [thead_&:is(th)]:([background:var(--scova-selected)] [font-family:var(--scova-font-interface)]) [thead_&:is(th):first-child]:w-16 [thead_&:is(th):last-child]:w-[8rem]"
                            scope="col"
                        >
                            信息与引用
                        </th>
                        <th
                            class="text-start [vertical-align:top] border-theme break-anywhere p-4 [thead_&:is(th)]:([background:var(--scova-selected)] [font-family:var(--scova-font-interface)]) [thead_&:is(th):first-child]:w-16 [thead_&:is(th):last-child]:w-[8rem]"
                            scope="col"
                        >
                            资料类型
                        </th>
                    </tr>
                </thead>
                <tbody v-for="section in sections" :key="section.kind">
                    <tr class="findings-group">
                        <th
                            class="text-start [vertical-align:top] border-theme break-anywhere p-4 [thead_&:is(th)]:([background:var(--scova-selected)] [font-family:var(--scova-font-interface)]) [.findings-group_&:is(th)]:([background:var(--scova-selected)] [font-family:var(--scova-font-interface)]) [thead_&:is(th):first-child]:w-16 [thead_&:is(th):last-child]:w-[8rem]"
                            colspan="3"
                            scope="rowgroup"
                        >
                            <h3
                                :id="`claims-${section.kind}`"
                                class="scova-content-title text-[1.25rem] m-0 [.findings-group_&:is(h3)]:text-[1rem]"
                            >
                                {{ section.title }}
                            </h3>
                        </th>
                    </tr>
                    <tr
                        v-for="(claim, index) in section.claims"
                        :key="claim.id"
                        class="finding-row"
                    >
                        <th
                            scope="row"
                            class="scova-interface text-start [vertical-align:top] border-theme break-anywhere p-4 [thead_&:is(th)]:([background:var(--scova-selected)] [font-family:var(--scova-font-interface)]) [thead_&:is(th):first-child]:w-16 [thead_&:is(th):last-child]:w-[8rem]"
                        >
                            {{ String(index + 1).padStart(2, '0') }}
                        </th>
                        <td class="text-start [vertical-align:top] border-theme break-anywhere p-4">
                            <report-claim :report="report" :claim="claim" />
                        </td>
                        <td
                            class="scova-interface text-start [vertical-align:top] border-theme break-anywhere p-4"
                        >
                            {{ section.title }}
                        </td>
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
