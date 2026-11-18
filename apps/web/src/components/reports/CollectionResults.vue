<template>
    <section class="layout-grid gap-3" aria-labelledby="collection-results-title">
        <h3 id="collection-results-title" class="scova-content-title m-0">已采集条目</h3>
        <p v-if="!rows.length" class="m-0">
            本次尚无满足日期与直接出处要求的条目；待补充内容见查阅详情。
        </p>
        <template v-else>
            <p class="text-muted m-0" id="collection-scroll-hint">
                每个值均保留直接出处。表格可在自身区域左右滚动。
            </p>
            <div
                class="min-w-0 max-w-full overflow-x-auto keyboard-focus-wide"
                tabindex="0"
                role="region"
                aria-labelledby="collection-results-title"
                aria-describedby="collection-scroll-hint"
            >
                <table class="w-full min-w-[42rem] [table-layout:fixed] [border-collapse:collapse]">
                    <caption class="sr-only">
                        采集值、发布日期及直接出处
                    </caption>
                    <thead>
                        <tr>
                            <th
                                v-for="label in [
                                    '条目',
                                    '值',
                                    '发布或更新日期',
                                    '日期来源',
                                    '原文出处',
                                ]"
                                :key="label"
                                scope="col"
                                class="text-start border-theme p-3 bg-surface"
                            >
                                {{ label }}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="(row, index) in rows"
                            :key="row.claim.id"
                            :id="`claim-${row.claim.id}`"
                        >
                            <th scope="row" class="text-start align-top border-theme p-3">
                                {{ index + 1 }}
                            </th>
                            <td class="align-top border-theme p-3 break-anywhere">
                                {{ row.claim.text }}
                            </td>
                            <td class="align-top border-theme p-3 break-anywhere">
                                {{
                                    row.pages
                                        .map(
                                            (page) =>
                                                page.dateValue ?? page.publishedAt ?? '日期未确认',
                                        )
                                        .join('；')
                                }}
                            </td>
                            <td class="align-top border-theme p-3 break-anywhere">
                                {{
                                    row.pages
                                        .map((page) => dateSourceLabel(page.dateSource))
                                        .join('；')
                                }}
                            </td>
                            <td class="align-top border-theme p-3 break-anywhere">
                                <a
                                    v-for="evidence in row.evidence"
                                    :key="evidence.id"
                                    class="reference-link source-inline-action"
                                    :href="`#evidence-${evidence.id}`"
                                    >来源 {{ sourceNumber(evidence.id) }}</a
                                >
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </template>
    </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import { groupEvidence } from '@/utils/evidence-groups';
import { collectionRows, dateSourceLabel } from '@/utils/source-dates';
const props = defineProps<{ report: Report }>();
const groups = computed(() => groupEvidence(props.report.evidence));
const sourceNumber = (id: string) =>
    groups.value.findIndex((group) => group.evidence.some((entry) => entry.id === id)) + 1;
const rows = computed(() => collectionRows(props.report));
</script>
